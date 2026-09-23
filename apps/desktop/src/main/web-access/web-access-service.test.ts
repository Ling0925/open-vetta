import { describe, expect, it, vi } from "vitest";
import { ProjectChangeHub } from "../projects/project-change-hub.js";
import type { WebAccessServerHandle, WebAccessServerOptions } from "./web-access-server.js";
import type { DesktopWebAccessServiceDependencies } from "./web-access-service.js";
import { DesktopWebAccessService } from "./web-access-service.js";

const ASSETS = { get: () => undefined };

describe("DesktopWebAccessService", () => {
	it("accepts a bound local LAN origin but rejects unsafe HTTP origins", async () => {
		const service = createService({ getLanAddresses: () => ["192.168.1.21"] });
		await expect(service.configure({ origin: "http://192.168.1.21:45821", port: 45821 })).resolves.toMatchObject({
			status: "disabled",
			config: { origin: "http://192.168.1.21:45821", port: 45821 },
		});
		await expect(service.configure({ origin: "http://192.168.1.21:80", port: 80 })).resolves.toMatchObject({
			config: { origin: "http://192.168.1.21", port: 80 },
		});
		await service.configure({ origin: "http://192.168.1.21:45821", port: 45821 });
		for (const origin of [
			"http://web.test:45821",
			"http://8.8.8.8:45821",
			"http://0.0.0.0:45821",
			"http://192.168.1.22:45821",
			"http://192.168.1.21:45822",
		]) {
			await expect(service.configure({ origin, port: 45821 })).rejects.toThrow();
		}
		await expect(service.configure({ origin: "https://web.test/app", port: 45821 })).rejects.toThrow("origin");
		await expect(service.configure({ origin: "https://web.test", port: 0 })).rejects.toThrow("port");
		// Rejected changes do not replace the last valid configuration.
		expect(service.getState().config?.origin).toBe("http://192.168.1.21:45821");
	});

	it("serializes a pending start and a close without leaving a listener behind", async () => {
		let resolveAssets!: (assets: { get: () => undefined }) => void;
		const loadAssets = vi.fn(
			() =>
				new Promise<{ get: () => undefined }>((resolve) => {
					resolveAssets = resolve;
				}),
		);
		const close = vi.fn(async () => undefined);
		const startServer = vi.fn(
			async (): Promise<WebAccessServerHandle> => ({
				address: "http://127.0.0.1:45821",
				close,
				abortGrant: vi.fn(),
			}),
		);
		const service = createService({ loadAssets, startServer });
		await service.configure({ origin: "https://web.test", port: 45821 });

		// 开启还没拿到静态资源就点了关闭：关闭必须排在开启之后收尾，而不是先返回。
		const enabling = service.enable();
		const disabling = service.disable();
		await vi.waitFor(() => expect(loadAssets).toHaveBeenCalledOnce());
		resolveAssets(ASSETS);
		await Promise.all([enabling, disabling]);

		expect(service.getState().status).toBe("disabled");
		expect(startServer).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();

		// 句柄已经释放：再关一次不应该重复关闭，也不应该留下启动状态。
		await service.disable();
		expect(close).toHaveBeenCalledOnce();
	});

	it("keeps configuration and the actual listener consistent when the origin changes", async () => {
		const started: WebAccessServerOptions[] = [];
		const closes: string[] = [];
		const startServer = vi.fn(async (options: WebAccessServerOptions): Promise<WebAccessServerHandle> => {
			started.push(options);
			return {
				address: `http://127.0.0.1:${options.port}`,
				close: async () => {
					closes.push(options.origin);
				},
				abortGrant: vi.fn(),
			};
		});
		const service = createService({ loadAssets: async () => ASSETS, startServer });
		await service.configure({ origin: "https://web.test", port: 45821 });
		await service.enable();

		await service.configure({ origin: "https://other.test", port: 45822 });

		// 旧监听器按旧 Origin 校验 Host，换配置时必须先把它关掉再记新配置。
		expect(closes).toEqual(["https://web.test"]);
		expect(service.getState()).toMatchObject({
			status: "disabled",
			config: { origin: "https://other.test", port: 45822 },
		});

		await service.enable();
		expect(started.map((options) => options.origin)).toEqual(["https://web.test", "https://other.test"]);
		// 每次开启都用新世代，撤销与配对凭据不会跨生命周期复用。
		expect(started[1]?.generation).not.toBe(started[0]?.generation);
	});

	it("reports a failed start as an error instead of a running service", async () => {
		const service = createService({
			loadAssets: async () => ASSETS,
			startServer: async () => {
				throw new Error("EADDRINUSE");
			},
		});
		await service.configure({ origin: "https://web.test", port: 45821 });

		await expect(service.enable()).rejects.toThrow("EADDRINUSE");
		expect(service.getState()).toMatchObject({ status: "error", error: "EADDRINUSE" });

		// 失败之后仍可正常关闭，状态回到 disabled。
		await service.disable();
		expect(service.getState().status).toBe("disabled");
	});

	it("fails closed when the selected LAN interface disappears before enabling", async () => {
		let addresses = ["192.168.1.21"];
		const startServer = vi.fn();
		const service = createService({ getLanAddresses: () => addresses, startServer });
		await service.configure({ origin: "http://192.168.1.21:45821", port: 45821 });
		addresses = [];
		await expect(service.enable()).rejects.toThrow("Local network address is unavailable");
		expect(startServer).not.toHaveBeenCalled();
	});

	it("requires configuration before enabling", async () => {
		const service = createService();
		await expect(service.enable()).rejects.toThrow("Configure a local network address or HTTPS origin");
		expect(service.getState().status).toBe("disabled");
	});
});

function createService(overrides: Partial<DesktopWebAccessServiceDependencies> = {}): DesktopWebAccessService {
	return new DesktopWebAccessService({
		projectService: { list: async () => ({ workspacePath: "C:/workspace", projects: [], archivedProjects: [] }) },
		projectChanges: new ProjectChangeHub("00000000-0000-4000-8000-000000000001"),
		webRoot: "unused",
		loadAssets: async () => ASSETS,
		...overrides,
	});
}
