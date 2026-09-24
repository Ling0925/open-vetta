import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationOwnershipLease, ConversationOwnershipManager } from "@vetta/runtime-storage/conversation";
import { CodexRuntimeHostBackend } from "../../src/codex-app-server/host-backend.js";
import { CodexRpcConnection } from "../../src/codex-app-server/rpc.js";
import { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import type { CodexThread, CodexTransport, JsonObject, OpenCodexSessionOptions, TransportEvent } from "../../src/codex-app-server/types.js";

/** Storage boundary fixture; production composition uses the existing file ownership manager. */
export class TestOwnership implements ConversationOwnershipManager {
	readonly held = new Set<string>();
	async acquire(path: string): Promise<ConversationOwnershipLease> {
		if (this.held.has(path)) throw new Error("already owned");
		this.held.add(path);
		return { conversationPath: path, lockPath: `${path}.owner.lock`, holder: {
			token: randomUUID(), pid: process.pid, hostname: "test", acquiredAt: new Date().toISOString(),
		}, release: async () => { this.held.delete(path); } };
	}
}

export class HostTransport implements CodexTransport {
	readonly sent: JsonObject[] = [];
	readonly listeners = new Set<(event: TransportEvent) => void>();
	closed = false;
	active?: JsonObject;
	private readonly calls = new Map<string, ReturnType<typeof deferred<JsonObject>>>();
	constructor(readonly thread: { id: string; turns: JsonObject[] }) {}
	subscribe(fn: (event: TransportEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	async close() { this.closed = true; }
	async send(frame: JsonObject) {
		if (this.closed) throw new Error("closed transport");
		this.sent.push(frame);
		this.calls.get(String(frame.method))?.resolve(frame);
		if (frame.method === "initialize") this.reply(frame, { userAgent: "test" });
		if (frame.method === "thread/read") this.reply(frame, { thread: structuredClone(this.thread) });
		if (frame.method === "turn/start") {
			const params = frame.params as { input: Array<{ text: string }>; clientUserMessageId: string };
			const id = `turn-${this.thread.turns.length + 1}`;
			const user = { id: `user-${id}`, type: "userMessage", clientId: params.clientUserMessageId,
				content: [{ type: "text", text: params.input[0].text }] };
			this.active = { id, status: "inProgress", itemsView: "full", startedAt: 100, items: [user], error: null };
			this.reply(frame, { turn: { ...this.active, items: [] } });
			this.notify("turn/started", { turn: { ...this.active, items: [] } });
			this.notify("item/completed", { turnId: id, item: user });
		}
		if (frame.method === "turn/steer") this.reply(frame, { turnId: this.active?.id });
		if (frame.method === "turn/interrupt") this.reply(frame, {});
	}
	async waitFor(method: string): Promise<JsonObject> {
		const frame = this.sent.find((entry) => entry.method === method);
		if (frame) return frame;
		const wait = deferred<JsonObject>(); this.calls.set(method, wait); return wait.promise;
	}
	reply(request: JsonObject, result: unknown) { this.emit({ id: request.id, result }); }
	emit(message: unknown) { for (const listener of [...this.listeners]) listener({ type: "message", message }); }
	notify(method: string, params: JsonObject) { this.emit({ method, params: { threadId: this.thread.id, ...params } }); }
	failure() { for (const listener of [...this.listeners]) listener({ type: "failure", error: new Error("EOF") }); }
	finish(status = "completed", response = "final result") {
		if (!this.active) throw new Error("missing active turn");
		const id = String(this.active.id);
		const item = { id: `assistant-${id}`, type: "agentMessage", text: response };
		this.notify("item/started", { turnId: id, item: { ...item, text: "" } });
		this.notify("item/agentMessage/delta", { turnId: id, itemId: item.id, delta: "partial" });
		this.notify("item/completed", { turnId: id, item });
		const turn = { ...this.active, status, items: [...this.active.items as JsonObject[], item],
			error: status === "failed" ? { message: "tool failed" } : null };
		this.thread.turns.push(turn);
		// Real protocol permits a terminal status without loaded item history.
		this.notify("turn/completed", { turn: { ...turn, itemsView: "notLoaded", items: [] } });
		this.active = undefined;
	}
}

export async function hostFixture() {
	const root = await mkdtemp(join(tmpdir(), "vetta-codex-host-"));
	const cwd = join(root, "workspace"); const codexHome = join(root, "home"); const catalogRoot = join(root, "index");
	await Promise.all([mkdir(cwd), mkdir(codexHome)]);
	const ownership = new TestOwnership();
	const threads = new Map<string, { id: string; turns: JsonObject[] }>();
	const transports: HostTransport[] = [];
	const connected = deferred<HostTransport>();
	const connect = async (options: OpenCodexSessionOptions) => {
		const thread = options.threadId ? threads.get(options.threadId) : { id: randomUUID(), turns: [] };
		if (!thread) throw new Error("unknown thread");
		threads.set(thread.id, thread);
		const transport = new HostTransport(thread); transports.push(transport);
		const rpc = new CodexRpcConnection(transport, { requestTimeoutMs: 1000 }); await rpc.initialize();
		const session = new CodexAppServerSession(rpc, structuredClone(thread) as CodexThread, { interruptTimeoutMs: 500 });
		connected.resolve(transport);
		return session;
	};
	const config = { catalogRoot, profile: { id: "local", executable: process.execPath, expectedVersion: "0.0.0-test", codexHome }, ownership, connect };
	const backend = new CodexRuntimeHostBackend(config);
	const request = { cwd, executionMode: "sandbox" as const, getSessionId: () => undefined };
	return { root, cwd, config, backend, ownership, transports, threads, request, connected,
		cleanup: async () => { await backend.dispose(); await rm(root, { recursive: true, force: true }); } };
}
