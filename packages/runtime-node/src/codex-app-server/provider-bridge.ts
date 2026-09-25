import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CodexGatewayTarget {
	identity: string;
	revision: string;
	model: string;
	baseUrl: string;
	headers: Readonly<Record<string, string>>;
	reasoning?: string;
}
export interface CodexGatewaySource {
	/** Resolve from the host's existing configuration/vault on every upstream request. */
	resolve(): Promise<CodexGatewayTarget>;
	fetch: typeof globalThis.fetch;
	subscribe?(invalidate: () => void): () => void;
}
export interface CodexGatewayProvider {
	readonly id: string;
	readonly baseUrl: string;
	readonly bearerToken: string;
	readonly model: string;
	readonly reasoning?: string;
}
export interface CodexProviderBridge {
	readonly identity: string;
	readonly provider: CodexGatewayProvider;
	assertCurrent(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}
export class CodexGatewayError extends Error {
	constructor(readonly code: string) { super(code); this.name = "CodexGatewayError"; }
}
const fail = (code: string): never => { throw new CodexGatewayError(code); };
const errorBody = (code: string) => JSON.stringify({ error: { type: "vetta_gateway_error", code, message: code } });
const BODY_LIMIT = 16 * 1024 * 1024;
const DEADLINE_MS = 30 * 60 * 1000;

/** Stop waiting for a read without trusting the resolver to observe cancellation. Its late
 * result is handled but cannot dispatch a request or mutate an already cancelled caller. */
function abortableRead<T>(read: () => Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const listeners: Array<() => void> = [];
		const settle = (finish: () => void) => {
			if (settled) return;
			settled = true;
			for (const remove of listeners) remove();
			finish();
		};
		for (const signal of signals) {
			const abort = () => settle(() => reject(signal.reason));
			if (signal.aborted) { abort(); return; }
			signal.addEventListener("abort", abort, { once: true });
			listeners.push(() => signal.removeEventListener("abort", abort));
		}
		void Promise.resolve().then(() => {
			for (const signal of signals) signal.throwIfAborted();
			return read();
		}).then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
	});
}

/** Ephemeral, authenticated loopback bridge. Upstream credentials never enter Codex config/env/argv. */
export async function startCodexProviderBridge(source: CodexGatewaySource): Promise<CodexProviderBridge> {
	const initial = structuredClone(await source.resolve());
	const token = randomBytes(32).toString("hex");
	const authorization = Buffer.from(`Bearer ${token}`);
	const running = new Set<AbortController>();
	const lifetime = new AbortController();
	let invalid = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	const invalidate = () => {
		invalid = true;
		const reason = new CodexGatewayError(closed ? "GATEWAY_CLOSED" : "MODEL_CONFIGURATION_CHANGED");
		lifetime.abort(reason);
		for (const controller of running) controller.abort(reason);
	};
	const unsubscribe = source.subscribe?.(invalidate);
	const current = async (signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (closed) return fail("GATEWAY_CLOSED");
		if (invalid) return fail("MODEL_CONFIGURATION_CHANGED");
		let target: CodexGatewayTarget;
		try {
			target = await abortableRead(() => source.resolve(), [lifetime.signal, ...(signal ? [signal] : [])]);
		} catch (error) {
			// Cancelling one preflight must not revoke a valid bridge needed by the next user turn.
			if (!signal?.aborted) invalidate();
			throw error;
		}
		if (closed || invalid || initial.identity !== target.identity || initial.revision !== target.revision) {
			invalidate(); return fail("MODEL_CONFIGURATION_CHANGED");
		}
		return target;
	};
	let expectedHost = "";
	const server = createServer((request, response) => { void forward(request, response); });
	server.maxHeadersCount = 40;
	server.headersTimeout = 15000;
	server.requestTimeout = 60000;
	server.keepAliveTimeout = 1000;
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("error", invalidate);
	async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
		const disconnected = () => { if (!response.writableFinished) controller.abort(); };
		request.on("aborted", disconnected); response.on("close", disconnected);
		try {
			const supplied = Buffer.from(request.headers.authorization ?? "");
			if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization) ||
				request.headers.host !== expectedHost || request.headers.origin !== undefined ||
				request.headers["sec-fetch-site"] !== undefined) fail("GATEWAY_ACCESS_DENIED");
			const route = request.url === "/v1/responses" ? "/responses" :
				request.url === "/v1/responses/compact" ? "/responses/compact" : undefined;
			if (request.method !== "POST" || route === undefined) throw new CodexGatewayError("GATEWAY_ROUTE_UNSUPPORTED");
			if (running.size >= 4) fail("GATEWAY_BUSY");
			running.add(controller);
			if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) fail("GATEWAY_BODY_INVALID");
			const parts: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += part.length;
				if (size > BODY_LIMIT) fail("GATEWAY_BODY_LIMIT");
				parts.push(part);
			}
			let body: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("GATEWAY_BODY_INVALID");
				body = parsed as Record<string, unknown>;
			} catch { return fail("GATEWAY_BODY_INVALID"); }
			const target = await current(controller.signal);
			if (body.model !== target.model) fail("GATEWAY_MODEL_MISMATCH");
			controller.signal.throwIfAborted();
			// The incoming client cannot select a target URL, headers, credentials or model alias.
			const result = await source.fetch(`${target.baseUrl}${route}`, {
				method: "POST", headers: { ...target.headers, "content-type": "application/json" },
				body: JSON.stringify(body), redirect: "manual", signal: controller.signal,
			});
			if (result.status >= 300 && result.status < 400) {
				await result.body?.cancel(); fail("GATEWAY_REDIRECT_REJECTED");
			}
			if (!result.ok) {
				await result.body?.cancel();
				response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
				response.end(errorBody(`GATEWAY_HTTP_${result.status}`)); return;
			}
			const contentType = result.headers.get("content-type") ?? "";
			if (!contentType.startsWith("text/event-stream") && !contentType.startsWith("application/json")) {
				await result.body?.cancel(); fail("GATEWAY_RESPONSE_INVALID");
			}
			response.writeHead(result.status, { "content-type": contentType, "cache-control": "no-store" });
			if (result.body) {
				const reader = result.body.getReader();
				try {
					while (true) {
						controller.signal.throwIfAborted();
						const chunk = await reader.read();
						if (chunk.done) break;
						if (!response.write(chunk.value)) await once(response, "drain", { signal: controller.signal });
					}
				} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
			}
			response.end();
		} catch (error) {
			const code = error instanceof CodexGatewayError ? error.code : "GATEWAY_REQUEST_FAILED";
			if (response.headersSent) response.destroy();
			else if (!response.destroyed) {
				response.writeHead(code === "GATEWAY_ACCESS_DENIED" ? 403 : 502,
					{ "content-type": "application/json", "cache-control": "no-store" });
				response.end(errorBody(code));
			}
		} finally {
			clearTimeout(timer); running.delete(controller);
			request.removeListener("aborted", disconnected); response.removeListener("close", disconnected);
		}
	}
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
		});
		await current();
	} catch (error) {
		closed = true; invalidate(); unsubscribe?.();
		await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") { unsubscribe?.(); server.close(); return fail("GATEWAY_START_FAILED"); }
	expectedHost = `127.0.0.1:${address.port}`;
	return {
		identity: initial.identity,
		provider: { id: `vetta_${randomBytes(12).toString("hex")}`, baseUrl: `http://${expectedHost}/v1`,
			bearerToken: token, model: initial.model, ...(initial.reasoning ? { reasoning: initial.reasoning } : {}) },
		assertCurrent: async signal => { await current(signal); },
		close: () => {
			if (closing) return closing;
			closed = true; invalidate(); unsubscribe?.();
			closing = new Promise<void>((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
			});
			return closing;
		},
	};
}

/** Only loopback routing metadata and a revocable local token are given to Codex. */
export function codexGatewayThreadConfig(provider: CodexGatewayProvider) {
	const url = new URL(provider.baseUrl);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/v1" ||
		url.username || url.password || url.search || url.hash || !/^vetta_[a-f0-9]{24}$/.test(provider.id) ||
		!/^[a-f0-9]{64}$/.test(provider.bearerToken)) fail("GATEWAY_BINDING_INVALID");
	return {
		modelProvider: provider.id,
		model: provider.model,
		config: {
			model_provider: provider.id,
			model: provider.model,
			...(provider.reasoning ? { model_reasoning_effort: provider.reasoning } : {}),
			model_providers: { [provider.id]: {
				name: "Vetta configured gateway", base_url: provider.baseUrl, wire_api: "responses",
				requires_openai_auth: false, supports_websockets: false,
				request_max_retries: 0, stream_max_retries: 0,
				http_headers: { Authorization: `Bearer ${provider.bearerToken}` },
			} },
		},
	};
}
