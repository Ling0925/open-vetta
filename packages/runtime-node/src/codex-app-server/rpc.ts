import { object, positive, rpcId, safeNotify, text } from "./protocol.js";
import { CodexRuntimeError, type CodexTransport, type JsonObject, type RpcId, type RpcOptions } from "./types.js";
interface Pending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}
interface Inbound {
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
}
/** One connection, one handshake. A timeout poisons the connection; mutating requests are never replayed. */
export class CodexRpcConnection {
	private state: "new" | "initializing" | "ready" | "closed" = "new";
	private nextId = 0;
	private readonly pending = new Map<RpcId, Pending>();
	private readonly inbound = new Map<RpcId, Inbound>();
	private readonly listeners = new Set<(event: {
		method: string;
		params: JsonObject;
	}) => void>();
	private readonly failures = new Set<(error: Error) => void>();
	private readonly unsubscribe: () => void;
	private readonly timeout: number;
	private readonly serverTimeout: number;
	private readonly limit: number;
	private closing?: Promise<void>;
	constructor(private readonly transport: CodexTransport, private readonly options: RpcOptions = {}) {
		this.timeout = positive(options.requestTimeoutMs, 30000);
		this.serverTimeout = positive(options.serverRequestTimeoutMs, 60000);
		this.limit = positive(options.maxPendingRequests, 64);
		this.unsubscribe = transport.subscribe((event) => {
			if (event.type === "failure")
				this.fail(event.error);
			else
				this.receive(event.message);
		});
	}
	async initialize(): Promise<void> {
		if (this.state !== "new")
			throw new CodexRuntimeError("NOT_READY", "Connection initialization is single-use");
		this.state = "initializing";
		try {
			const response = object(await this.call("initialize", {
				clientInfo: { name: "open_vetta", title: "Open Vetta", version: "0.1.0" },
				capabilities: { experimentalApi: false },
			}));
			text(response.userAgent, "initialize.userAgent");
			await this.transport.send({ method: "initialized", params: {} });
			if (this.isClosed())
				throw new CodexRuntimeError("CLOSED", "Connection closed during initialization");
			this.state = "ready";
		}
		catch (error) {
			await this.close();
			throw error;
		}
	}
	request(method: string, params: JsonObject = {}): Promise<unknown> {
		if (this.state !== "ready")
			return Promise.reject(new CodexRuntimeError("NOT_READY", "App-server is not ready", method));
		return this.call(method, params);
	}
	subscribe(listener: (event: {
		method: string;
		params: JsonObject;
	}) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onFailure(listener: (error: Error) => void): () => void {
		this.failures.add(listener);
		return () => this.failures.delete(listener);
	}
	close(): Promise<void> {
		if (this.closing)
			return this.closing;
		this.closing = Promise.resolve().then(() => this.transport.close());
		this.fail(new CodexRuntimeError("CLOSED", "App-server connection closed"));
		this.unsubscribe();
		return this.closing;
	}
	private isClosed(): boolean { return this.state === "closed"; }
	private call(method: string, params: JsonObject): Promise<unknown> {
		if (this.pending.size >= this.limit)
			return Promise.reject(new CodexRuntimeError("LIMIT", "Too many pending app-server requests"));
		const id = `vetta:${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.fail(new CodexRuntimeError("OUTCOME_UNKNOWN", `App-server ${method} timed out; reconcile before retrying`, method));
			}, this.timeout);
			this.pending.set(id, { resolve, reject, timer });
			void this.transport.send({ id, method, params }).catch((error: unknown) => {
				this.fail(error instanceof Error ? error : new CodexRuntimeError("TRANSPORT", "App-server write failed"));
			});
		});
	}
	private receive(value: unknown): void {
		if (this.state === "closed")
			return;
		try {
			const frame = object(value);
			if (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0")
				throw new Error("Unsupported JSON-RPC version");
			if (typeof frame.method === "string") {
				const params = frame.params === undefined ? {} : object(frame.params);
				if (frame.id !== undefined) {
					this.handleRequest(rpcId(frame.id), frame.method, params);
				}
				else {
					if (frame.method === "serverRequest/resolved" && params.requestId !== undefined) {
						this.cancelInbound(rpcId(params.requestId));
					}
					safeNotify(this.listeners, { method: frame.method, params });
				}
				return;
			}
			const id = rpcId(frame.id);
			if (("result" in frame) === ("error" in frame))
				throw new Error("Invalid JSON-RPC response");
			const pending = this.pending.get(id);
			if (!pending)
				return;
			const error = "error" in frame ? object(frame.error) : undefined;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (error) {
				pending.reject(new CodexRuntimeError("REMOTE", String(error.message ?? "App-server request failed").slice(0, 512), undefined, typeof error.code === "number" ? error.code : undefined));
			}
			else
				pending.resolve(frame.result);
		}
		catch {
			this.fail(new CodexRuntimeError("PROTOCOL", "Invalid app-server frame; connection closed"));
		}
	}
	private handleRequest(id: RpcId, method: string, params: JsonObject): void {
		if (this.inbound.has(id) || this.inbound.size >= this.limit) {
			this.fail(new CodexRuntimeError("PROTOCOL", "Duplicate or excessive app-server requests"));
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			this.cancelInbound(id);
			this.sendReply({ id, error: { code: -32000, message: "Host request timed out; no permission granted" } });
		}, this.serverTimeout);
		const entry = { controller, timer };
		this.inbound.set(id, entry);
		void (async () => {
			try {
				if (!this.options.onRequest)
					throw new CodexRuntimeError("UNSUPPORTED", "Host capability unavailable", method, -32601);
				const result = await this.options.onRequest({ id, method, params: structuredClone(params), signal: controller.signal });
				if (!controller.signal.aborted && this.inbound.get(id) === entry)
					this.sendReply({ id, result: result ?? null });
			}
			catch (error) {
				if (!controller.signal.aborted && this.inbound.get(id) === entry) {
					this.sendReply({ id, error: { code: error instanceof CodexRuntimeError ? error.rpcCode ?? -32000 : -32000,
							message: "Host request rejected; no permission granted" } });
				}
			}
			finally {
				if (this.inbound.get(id) === entry)
					this.cancelInbound(id);
			}
		})();
	}
	private sendReply(frame: JsonObject): void {
		if (this.state === "closed")
			return;
		void this.transport.send(frame).catch(() => this.fail(new CodexRuntimeError("TRANSPORT", "App-server response write failed")));
	}
	private cancelInbound(id: RpcId): void {
		const entry = this.inbound.get(id);
		if (!entry)
			return;
		this.inbound.delete(id);
		clearTimeout(entry.timer);
		entry.controller.abort();
	}
	private fail(error: Error): void {
		if (this.state === "closed")
			return;
		this.state = "closed";
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
		for (const id of this.inbound.keys())
			this.cancelInbound(id);
		for (const listener of [...this.failures]) {
			try {
				listener(error);
			}
			catch { /* Observer isolation. */ }
		}
		void this.transport.close().catch(() => undefined);
	}
}
