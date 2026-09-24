import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { CodexRpcConnection } from "../../src/codex-app-server/rpc.js";
import { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import type { CodexSessionEvent, CodexSessionOptions, ServerRequest } from "../../src/codex-app-server/types.js";
import { flush, MemoryTransport, turn } from "./helpers.js";
const sessions: CodexAppServerSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });
async function make(options: CodexSessionOptions = {}, rpcTimeout = 1000) {
	const transport = new MemoryTransport();
	let session: CodexAppServerSession;
	const rpc = new CodexRpcConnection(transport, { requestTimeoutMs: rpcTimeout,
		onRequest: (request) => session.handleServerRequest(request) });
	await rpc.initialize();
	session = new CodexAppServerSession(rpc, { id: "thread-1", turns: [] }, options);
	sessions.push(session);
	const started = async (id = "turn-1") => {
		const pending = session.startTurn({ text: "work" });
		transport.reply(transport.requests("turn/start").at(-1)!, { turn: turn(id) });
		return pending;
	};
	const complete = (id = "turn-1", status = "completed") => transport.notify("turn/completed", { threadId: "thread-1", turn: turn(id, status) });
	return { transport, session, started, complete };
}
describe("Codex session admission, steering and terminal ownership", () => {
	it("supports start → stream → steer → stop → follow-up without treating acknowledgments as completion", async () => {
		const { transport, session, started, complete } = await make();
		const events: CodexSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		const handle = await started();
		await assert.rejects(session.startTurn({ text: "duplicate" }), { code: "BUSY" });
		transport.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "hello" });
		const steering = session.steer({ text: "change", expectedTurnId: "turn-1" });
		transport.reply(transport.requests("turn/steer")[0], { turnId: "turn-1" });
		await steering;
		let stopped = false;
		const stop = session.interrupt("turn-1").then(() => { stopped = true; });
		await flush();
		transport.reply(transport.requests("turn/interrupt")[0], {});
		await flush();
		assert.equal(stopped, false);
		assert.equal(session.readState().state, "cancelling");
		complete("turn-1", "interrupted");
		await stop;
		assert.equal((await handle.completed).status, "interrupted");
		const next = await started("turn-2");
		complete("turn-2");
		assert.equal((await next.completed).status, "completed");
		assert.equal(session.readThread().turns.length, 2);
		assert.equal(events.filter((event) => event.method === "turn/completed").length, 2);
		assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence));
	});
	it("binds early terminal notifications to the acknowledged turn and ignores old/foreign events", async () => {
		const { transport, session } = await make();
		const start = session.startTurn({ text: "work" });
		transport.notify("turn/completed", { threadId: "thread-1", turn: turn("old", "completed") });
		transport.notify("turn/completed", { threadId: "other", turn: turn("turn-1", "completed") });
		transport.notify("turn/completed", { threadId: "thread-1", turn: turn("turn-1", "completed") });
		transport.reply(transport.requests("turn/start")[0], { turn: turn() });
		assert.equal((await (await start).completed).id, "turn-1");
		assert.equal(session.readThread().turns.length, 1);
		assert.equal(session.readState().state, "idle");
	});
	it("stops a starting turn once its ID is acknowledged, without starting another one", async () => {
		const { transport, session, complete } = await make();
		const start = session.startTurn({ text: "work" });
		const stop = session.interrupt();
		transport.reply(transport.requests("turn/start")[0], { turn: turn() });
		const handle = await start;
		await flush();
		assert.equal((transport.requests("turn/interrupt")[0].params as Record<string, unknown>).turnId, "turn-1");
		transport.reply(transport.requests("turn/interrupt")[0], {});
		complete("turn-1", "interrupted");
		await stop;
		assert.equal((await handle.completed).status, "interrupted");
		assert.equal(transport.requests("turn/start").length, 1);
	});
	it("does not direct a stale stop or steering request at a newer turn", async () => {
		const { transport, session, started, complete } = await make();
		const first = await started();
		complete();
		await first.completed;
		const second = await started("turn-2");
		await assert.rejects(session.interrupt("turn-1"), { code: "TURN_MISMATCH" });
		await assert.rejects(session.steer({ text: "stale", expectedTurnId: "turn-1" }), { code: "TURN_MISMATCH" });
		complete("turn-1");
		assert.equal(session.readState().turnId, "turn-2");
		assert.equal(transport.requests("turn/interrupt").length, 0);
		complete("turn-2");
		await second.completed;
	});
	it("returns idle on a definite rejected start, but requires recovery after an uncertain start", async () => {
		const { transport, session } = await make({}, 15);
		const first = assert.rejects(session.startTurn({ text: "invalid" }), { code: "REMOTE" });
		transport.message({ id: transport.requests("turn/start")[0].id, error: { code: -32602, message: "invalid model" } });
		await first;
		assert.equal(session.readState().state, "idle");
		await assert.rejects(session.startTurn({ text: "timeout" }), { code: "OUTCOME_UNKNOWN" });
		assert.equal(session.readState().state, "recovery-required");
		await assert.rejects(session.startTurn({ text: "retry" }), { code: "RECOVERY_REQUIRED" });
		assert.equal(transport.requests("turn/start").length, 2);
	});
	it("keeps an unconfirmed stop in recovery-required, not idle", async () => {
		const { transport, session, started } = await make({ interruptTimeoutMs: 15 });
		const handle = await started();
		const completion = assert.rejects(handle.completed, { code: "OUTCOME_UNKNOWN" });
		const stopping = assert.rejects(session.interrupt(), { code: "OUTCOME_UNKNOWN" });
		await flush();
		transport.reply(transport.requests("turn/interrupt")[0], {});
		await Promise.all([completion, stopping]);
		assert.equal(session.readState().state, "recovery-required");
	});
	it("cancels pending approvals and rejects a late accept after stop", async () => {
		const request = deferred<ServerRequest>();
		const decision = deferred<"accept">();
		const { transport, session, started, complete } = await make({ onApproval: async (value) => {
				request.resolve(value);
				return decision.promise;
			} });
		const handle = await started();
		transport.message({ id: 5, method: "item/commandExecution/requestApproval",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "i", command: "write" } });
		const approval = await request.promise;
		const stopping = session.interrupt();
		assert.equal(approval.signal.aborted, true);
		decision.resolve("accept");
		await flush();
		await flush();
		const response = transport.sent.find((frame) => frame.id === 5);
		assert.deepEqual(response?.result, { decision: "cancel" });
		transport.reply(transport.requests("turn/interrupt")[0], {});
		complete("turn-1", "interrupted");
		await stopping;
		await handle.completed;
	});
	it("declines approvals by default and cancels approvals belonging to another thread", async () => {
		const { session, started, complete } = await make();
		const handle = await started();
		const request: ServerRequest = { id: 1, method: "item/fileChange/requestApproval",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "i" }, signal: new AbortController().signal };
		assert.deepEqual(await session.handleServerRequest(request), { decision: "decline" });
		assert.deepEqual(await session.handleServerRequest({ ...request, params: { ...request.params, threadId: "other" } }), { decision: "cancel" });
		await assert.rejects(session.handleServerRequest({ ...request, method: "item/permissions/requestApproval" }), { code: "UNSUPPORTED" });
		complete();
		await handle.completed;
	});
	it("does not reopen a session closed synchronously by a terminal observer", async () => {
		const { session, started, complete } = await make();
		session.subscribe((event) => {
			if (event.method === "turn/completed")
				void session.close();
		});
		const handle = await started();
		complete();
		await handle.completed;
		assert.equal(session.readState().state, "closed");
		await assert.rejects(session.startTurn({ text: "after close" }), { code: "CLOSED" });
	});
	it("does not send a new mutation when a starting-state observer closes the session", async () => {
		const { transport, session } = await make();
		session.subscribe((event) => {
			if (event.params.state === "starting")
				void session.close();
		});
		await assert.rejects(session.startTurn({ text: "work" }));
		assert.equal(transport.requests("turn/start").length, 0);
		assert.equal(session.readState().state, "closed");
	});
	it("does not overwrite a new turn admitted by a terminal observer", async () => {
		const { transport, session, started, complete } = await make();
		let next: ReturnType<typeof session.startTurn> | undefined;
		session.subscribe((event) => {
			if (event.method === "turn/completed" && (event.params.turn as Record<string, unknown>).id === "turn-1")
				next = session.startTurn({ text: "follow up" });
		});
		const handle = await started();
		complete();
		await handle.completed;
		assert.equal(session.readState().state, "starting");
		transport.reply(transport.requests("turn/start")[1], { turn: turn("turn-2") });
		assert.ok(next);
		const nextHandle = await next;
		complete("turn-2");
		await nextHandle.completed;
	});
	it("does not apply a stale history response to a newly admitted turn", async () => {
		const { transport, session, started, complete } = await make();
		const history = session.refreshHistory();
		const run = await started();
		transport.reply(transport.requests("thread/read")[0], { thread: { id: "thread-1", turns: [turn()] } });
		await history;
		assert.equal(session.readState().state, "running");
		complete();
		await run.completed;
	});
	it("does not report a confirmed stop when close wins before stop dispatch", async () => {
		const { session, started } = await make();
		const run = await started();
		const stop = session.interrupt(run.turnId);
		const rejected = assert.rejects(stop, { code: "CLOSED" });
		await session.close();
		await rejected;
		await assert.rejects(run.completed, { code: "CLOSED" });
	});
	it("delivers monotonically ordered events to all observers during reentrant close", async () => {
		const { session, started, complete } = await make();
		const observed: number[] = [];
		session.subscribe((event) => { if (event.method === "turn/completed")
			void session.close(); });
		session.subscribe((event) => observed.push(event.sequence));
		const run = await started();
		complete();
		await run.completed;
		assert.ok(observed.every((value, index) => index === 0 || value > observed[index - 1]));
		assert.equal(session.readState().state, "closed");
	});
});
