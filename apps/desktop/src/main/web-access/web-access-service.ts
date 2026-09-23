import type { WebAccessConfig, WebAccessPairResult, WebAccessState } from "../../shared/web-access.js";
import type { ProjectChangeHub } from "../projects/project-change-hub.js";
import type { ProjectService } from "../projects/project-service.js";
import { WebAccessAuthorization } from "./authorization.js";
import { getLanIPv4Addresses, isPrivateLanIPv4 } from "./lan-addresses.js";
import { DesktopProjectSnapshotSource } from "./project-snapshot.js";
import { loadWebStaticAssets, type WebStaticAssets } from "./static-assets.js";
import { startWebAccessServer, type WebAccessServerHandle, type WebAccessServerOptions } from "./web-access-server.js";

export interface DesktopWebAccessServiceDependencies {
	readonly projectService: Pick<ProjectService, "list">;
	readonly projectChanges: ProjectChangeHub;
	readonly webRoot: string;
	readonly now?: () => number;
	readonly loadAssets?: (root: string) => Promise<WebStaticAssets>;
	readonly startServer?: (options: WebAccessServerOptions) => Promise<WebAccessServerHandle>;
	readonly getLanAddresses?: () => readonly string[];
}

export class DesktopWebAccessService {
	private readonly authorization: WebAccessAuthorization;
	private readonly projects: DesktopProjectSnapshotSource;
	private readonly webRoot: string;
	private readonly loadAssets: (root: string) => Promise<WebStaticAssets>;
	private readonly startServer: (options: WebAccessServerOptions) => Promise<WebAccessServerHandle>;
	private readonly now: () => number;
	private readonly getLanAddresses: () => readonly string[];
	private lifecycleGeneration = 0;
	private server: WebAccessServerHandle | undefined;
	private config: WebAccessConfig | undefined;
	private status: WebAccessState["status"] = "disabled";
	private error: string | undefined;
	/**
	 * 开启、关闭、改配置与退出共用同一条完成链。
	 *
	 * 这些操作都要写同一组字段（世代、监听器、状态），之前分开用 `startPromise` / `stopPromise`
	 * 各自去重，就会出现「关掉时启动还没收尾」「第二个 close 提前返回」「配置换掉了但旧
	 * 监听器仍按旧 Origin 校验」这类交错。串行化后每次只有一个操作在跑，且下一个操作启动时
	 * 上一个已经**完整**结束（包括它创建出来的服务器已被关闭）。
	 */
	private lifecycle: Promise<unknown> = Promise.resolve();

	constructor(dependencies: DesktopWebAccessServiceDependencies) {
		this.now = dependencies.now ?? Date.now;
		this.authorization = new WebAccessAuthorization(this.now);
		this.projects = new DesktopProjectSnapshotSource(dependencies.projectService, dependencies.projectChanges);
		this.webRoot = dependencies.webRoot;
		this.loadAssets = dependencies.loadAssets ?? loadWebStaticAssets;
		this.startServer = dependencies.startServer ?? startWebAccessServer;
		this.getLanAddresses = dependencies.getLanAddresses ?? getLanIPv4Addresses;
	}

	getState(): WebAccessState {
		return {
			status: this.status,
			...(this.config ? { config: this.config } : {}),
			lanAddresses: this.getLanAddresses(),
			generation: this.lifecycleGeneration,
			grants: this.authorization.listGrants(),
			...(this.authorization.getPairingExpiresAt()
				? { pairingExpiresAt: this.authorization.getPairingExpiresAt() }
				: {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	async configure(input: unknown): Promise<WebAccessState> {
		const config = parseConfig(input, this.getLanAddresses());
		return await this.serialize(async () => {
			// 换 Origin 必须先停旧监听器：旧监听器仍按旧 Origin 校验 Host，配置与实际行为
			// 一旦不一致，用户以为已经换掉的入口其实还开着。
			await this.disableInternal();
			this.config = config;
			return this.getState();
		});
	}

	async enable(): Promise<WebAccessState> {
		return await this.serialize(async () => {
			if (this.status === "enabled") return this.getState();
			const config = this.config;
			if (!config) throw new Error("Configure a local network address or HTTPS origin before enabling Web access");
			// 配置后网卡可能已断开；启动前重新核对，不能在失效地址上监听。
			parseConfig(config, this.getLanAddresses());
			const generation = ++this.lifecycleGeneration;
			this.status = "starting";
			this.error = undefined;
			try {
				const assets = await this.loadAssets(this.webRoot);
				const server = await this.startServer({
					origin: config.origin,
					port: config.port,
					generation,
					assets,
					authorization: this.authorization,
					projects: this.projects,
				});
				// 串行化后不应该再出现世代不一致；保留检查是为了任何绕过 serialize 的调用也无法
				// 留下一个谁都不引用的监听器。
				if (generation !== this.lifecycleGeneration) {
					await server.close();
					return this.getState();
				}
				this.server = server;
				this.status = "enabled";
				return this.getState();
			} catch (error: unknown) {
				// 失败必须留下错误状态，不能把上一轮的监听器当成成功结果报出去。
				this.status = "error";
				this.error = error instanceof Error ? error.message : "Web access could not be enabled";
				throw error;
			}
		});
	}

	async disable(): Promise<WebAccessState> {
		return await this.serialize(() => this.disableInternal());
	}

	/** 串行化之后的重活；只由 {@link serialize} 的持有者调用。 */
	private async disableInternal(): Promise<WebAccessState> {
		// 先停准入与凭据，再断开连接：反过来的话，关闭期间到达的配对请求仍能换到授权。
		this.lifecycleGeneration += 1;
		this.status = "disabled";
		this.error = undefined;
		this.authorization.revokeAll();
		const server = this.server;
		try {
			if (server) await server.close();
		} catch (error: unknown) {
			this.status = "error";
			this.error = error instanceof Error ? error.message : "Web access could not be disabled";
			throw error;
		} finally {
			// 无论关闭成功与否都不再持有句柄：下一次 enable 不能误用一个已死的监听器；
			// 失败时状态已经是 error，不会报成正常关闭。
			if (this.server === server) this.server = undefined;
		}
		return this.getState();
	}

	/**
	 * 把开启、关闭、改配置排成一条链。
	 *
	 * 前一个操作无论成功还是失败，队列里的下一个都要接着跑；失败只影响发起它的调用方。
	 */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.lifecycle.then(operation, operation);
		this.lifecycle = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	pair(): WebAccessPairResult {
		if (this.status !== "enabled" || !this.config) throw new Error("Enable Web access before pairing a browser");
		const pairing = this.authorization.createPairing({
			origin: this.config.origin,
			generation: this.lifecycleGeneration,
			scopes: ["projects.read"],
		});
		return { webUrl: `${this.config.origin}/`, code: pairing.code, expiresAt: pairing.expiresAt };
	}

	revoke(grantId?: string): WebAccessState {
		if (grantId) {
			if (this.authorization.revoke(grantId)) this.server?.abortGrant(grantId);
		} else {
			for (const id of this.authorization.revokeAll()) this.server?.abortGrant(id);
		}
		return this.getState();
	}

	async dispose(): Promise<void> {
		await this.disable();
	}
}

function parseConfig(value: unknown, lanAddresses: readonly string[]): WebAccessConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Web access configuration must be an object");
	}
	const input = value as Record<string, unknown>;
	const origin = typeof input.origin === "string" ? input.origin.trim() : "";
	const port = typeof input.port === "number" ? input.port : Number(input.port);
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new Error("Web access origin must be a valid local HTTP or HTTPS origin");
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error("Web access port must be between 1 and 65535");
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("Web access origin must be an HTTP LAN address or HTTPS origin without a path or credentials");
	}
	if (parsed.protocol === "http:") {
		const address = parsed.hostname;
		if (address !== "127.0.0.1" && (!isPrivateLanIPv4(address) || !lanAddresses.includes(address))) {
			throw new Error("Local network address is unavailable on this computer");
		}
		const expectedOrigin = new URL(`http://${address}:${port}`).origin;
		const submittedOrigin = origin.replace(/\/$/, "");
		if (
			parsed.origin !== expectedOrigin ||
			(submittedOrigin !== expectedOrigin && submittedOrigin !== `http://${address}:${port}`)
		) {
			throw new Error("Local HTTP origin must include the same port as the Web access listener");
		}
	}
	return { origin: parsed.origin, port };
}
