import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { CodexRpcConnection } from "../../src/codex-app-server/rpc.js";
import type { ServerRequest } from "../../src/codex-app-server/types.js";
import { flush, MemoryTransport } from "./helpers.js";
const connections: CodexRpcConnection[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map((rpc) => rpc.close())); });
function make(options: ConstructorParameters<typeof CodexRpcConnection>[1] = {}) {
	const transport = new MemoryTransport();
	const rpc = new CodexRpcConnection(transport, options);
	connections.push(rpc);
	return { transport, rpc };
}
describe("Codex JSON-RPC lifecycle", () => {
	it("requires one handshake and does not send business requests before initialized", async () => {
		const { transport, rpc } = make();
		await assert.rejects(rpc.request("thread/start"), { code: "NOT_READY" });
		assert.equal(transport.sent.length, 0);
		await rpc.initialize();
		assert.deepEqual(transport.sent.map((frame) => frame.method), ["initialize", "initialized"]);
		await assert.rejects(rpc.initialize(), { code: "NOT_READY" });
	});
	it("correlates concurrent replies out of order without mixing results", async () => {
		const { transport, rpc } = make();
		await rpc.initialize();
		const first = rpc.request("thread/read", { threadId: "a" });
		const second = rpc.request("thread/read", { threadId: "b" });
		const frames = transport.requests("thread/read");
		transport.reply(frames[1], { value: "b" });
		transport.reply(frames[0], { value: "a" });
		assert.deepEqual(await Promise.all([first, second]), [{ value: "a" }, { value: "b" }]);
	});
	it("isolates notification listeners from each other and from request processing", async () => {
		const { transport, rpc } = make();
		await rpc.initialize();
		let observed: unknown;
		rpc.subscribe((event) => { (event.params as Record<string, unknown>).text = "mutated"; throw new Error("observer"); });
		rpc.subscribe((event) => { observed = event.params.text; });
		transport.notify("test", { text: "original" });
		assert.equal(observed, "original");
	});
	it("rejects unsupported server capabilities instead of acknowledging success", async () => {
		const { transport, rpc } = make();
		await rpc.initialize();
		transport.message({ id: 7, method: "item/tool/call", params: {} });
		await flush();
		const response = transport.sent.find((frame) => frame.id === 7);
		assert.equal((response?.error as Record<string, unknown>).code, -32601);
		assert.equal(response?.result, undefined);
	});
	it("does not return a late approval after serverRequest/resolved", async () => {
		const decision = deferred<unknown>();
		const requested = deferred<ServerRequest>();
		const { transport, rpc } = make({ onRequest: async (request) => { requested.resolve(request); return decision.promise; } });
		await rpc.initialize();
		transport.message({ id: "approval-1", method: "approval", params: {} });
		const request = await requested.promise;
		transport.notify("serverRequest/resolved", { requestId: "approval-1" });
		assert.equal(request.signal.aborted, true);
		decision.resolve({ decision: "accept" });
		await flush();
		assert.equal(transport.sent.some((frame) => frame.id === "approval-1"), false);
	});
	it("poisons a timed-out connection and never retries the original mutation", async () => {
		const { transport, rpc } = make({ requestTimeoutMs: 15 });
		await rpc.initialize();
		await assert.rejects(rpc.request("turn/start"), { code: "OUTCOME_UNKNOWN" });
		await assert.rejects(rpc.request("turn/start"), { code: "NOT_READY" });
		assert.equal(transport.requests("turn/start").length, 1);
		assert.equal(transport.closed, true);
	});
	it("rejects every pending request when EOF arrives", async () => {
		const { transport, rpc } = make();
		await rpc.initialize();
		const first = assert.rejects(rpc.request("turn/start"), /EOF/);
		const second = assert.rejects(rpc.request("thread/read"), /EOF/);
		transport.failure();
		await Promise.all([first, second]);
	});
	it("does not orphan a pending request on a malformed error envelope", async () => {
		const { transport, rpc } = make();
		await rpc.initialize();
		const request = assert.rejects(rpc.request("turn/start"), { code: "PROTOCOL" });
		transport.message({ id: transport.requests("turn/start")[0].id, error: "not an object" });
		await request;
	});
	it("limits pending requests without discarding existing work", async () => {
		const { transport, rpc } = make({ maxPendingRequests: 1 });
		await rpc.initialize();
		const first = rpc.request("thread/read");
		await assert.rejects(rpc.request("thread/read"), { code: "LIMIT" });
		transport.reply(transport.requests("thread/read")[0], { ok: true });
		assert.deepEqual(await first, { ok: true });
	});
	it("bounds host approval waiting and never sends a late successful reply", async () => {
		const gate = deferred<unknown>();
		const replied = deferred<void>();
		const { transport, rpc } = make({ serverRequestTimeoutMs: 15, onRequest: () => gate.promise });
		await rpc.initialize();
		transport.onSend = (frame) => {
			if (frame.id === 8)
				replied.resolve();
		};
		transport.message({ id: 8, method: "approval", params: {} });
		await replied.promise;
		gate.resolve({ decision: "accept" });
		await flush();
		const responses = transport.sent.filter((frame) => frame.id === 8);
		assert.equal(responses.length, 1);
		assert.ok(responses[0].error);
	});
});
