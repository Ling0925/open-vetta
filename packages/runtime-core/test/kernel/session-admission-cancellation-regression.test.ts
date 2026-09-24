import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAgentSession } from "../../src/kernel/agent-session.js";
import type { SessionInput, TurnResult, TurnSessionIdentity } from "../../src/kernel/contracts.js";
import { KERNEL_ERROR_CODES, KernelError } from "../../src/kernel/errors.js";
import type { TurnPipeline } from "../../src/kernel/turn-pipeline.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function input(text: string): SessionInput {
	return { message: { role: "user", content: text, timestamp: 1 } };
}

function completed(): TurnResult {
	return { status: "completed", sessionId: "session", turnId: "turn", stopReason: "stop", messages: [] };
}

function fixture() {
	const calls: Array<{
		input: SessionInput | undefined;
		signal: AbortSignal;
		completion: ReturnType<typeof deferred<TurnResult>>;
	}> = [];
	const waiting = new Map<number, ReturnType<typeof deferred<void>>>();
	let active = 0;
	let peak = 0;
	const run = (_identity: TurnSessionIdentity, value: SessionInput | undefined, signal: AbortSignal) => {
		const completion = deferred<TurnResult>();
		active += 1;
		peak = Math.max(peak, active);
		calls.push({ input: value, signal, completion });
		waiting.get(calls.length - 1)?.resolve();
		return completion.promise.finally(() => { active -= 1; });
	};
	const pipeline = {
		createSession: async () => {},
		resumeSession: async () => {},
		recordContext: async () => {},
		run,
		continue: (identity: TurnSessionIdentity, signal: AbortSignal) => run(identity, undefined, signal),
		retry: (identity: TurnSessionIdentity, signal: AbortSignal) => run(identity, undefined, signal),
	} as unknown as TurnPipeline;
	return {
		pipeline, calls,
		get peak() { return peak; },
		async waitForCall(index: number) {
			if (calls[index]) return;
			const gate = deferred<void>();
			waiting.set(index, gate);
			await gate.promise;
		},
	};
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof KernelError && error.code === code;
}

describe("queued admission and cancellation regressions", () => {
	it("admits only one simultaneous send-now request and retains the losing input", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const a = session.followUp(input("a"));
		const b = session.followUp(input("b"));
		assert.ok(a.id && b.id);
		const results = await Promise.allSettled([session.sendQueuedNow(a.id), session.sendQueuedNow(b.id)]);
		assert.equal(f.calls.length, 1);
		assert.equal(f.peak, 1);
		assert.equal(session.state, "running");
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [b.id]);
		const first = results[0];
		assert.equal(first.status, "fulfilled");
		if (first.status !== "fulfilled" || first.value.status !== "started") throw new Error("Expected admission");
		f.calls[0].completion.resolve(completed());
		await first.value.turn;
		assert.equal(session.state, "idle");
		const resume = session.resumeQueue();
		await f.waitForCall(1);
		f.calls[1].completion.resolve(completed());
		await resume;
		assert.equal(f.peak, 1);
		assert.equal(session.pendingMessageCount, 0);
	});

	it("does not cancel a new normal send that wins admission while send-now awaits", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const queued = session.followUp(input("queued"));
		assert.ok(queued.id);
		const active = session.send(input("normal"));
		const immediate = session.sendQueuedNow(queued.id);
		await assert.rejects(immediate, hasCode(KERNEL_ERROR_CODES.SESSION_BUSY));
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].signal.aborted, false);
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [queued.id]);
		f.calls[0].completion.resolve(completed());
		await active;
	});

	it("retains queue identity while waiting for the interrupted turn to release", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const active = session.send(input("old"));
		await f.waitForCall(0);
		const queued = session.followUp(input("next"));
		assert.ok(queued.id);
		const immediate = session.sendQueuedNow(queued.id);
		assert.equal(f.calls[0].signal.aborted, true);
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [queued.id]);
		f.calls[0].completion.resolve(completed());
		await active;
		const admitted = await immediate;
		assert.equal(admitted.status, "started");
		if (admitted.status !== "started") throw new Error("Expected admission");
		assert.equal(f.peak, 1);
		assert.equal(session.state, "running");
		f.calls[1].completion.resolve(completed());
		await admitted.turn;
	});

	it("a second explicit stop cancels a pending immediate send without losing its input", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const active = session.send(input("old"));
		await f.waitForCall(0);
		const queued = session.followUp(input("next"));
		assert.ok(queued.id);
		const immediate = session.sendQueuedNow(queued.id);
		const rejection = assert.rejects(immediate, hasCode(KERNEL_ERROR_CODES.TURN_INTERRUPTED));
		const stop = session.cancel("user stop");
		f.calls[0].completion.resolve(completed());
		await Promise.all([active, stop, rejection]);
		assert.equal(f.calls.length, 1);
		assert.equal(session.listQueue().paused, true);
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [queued.id]);
	});

	it("closing wins against pending immediate admission", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const queued = session.followUp(input("next"));
		assert.ok(queued.id);
		const immediate = session.sendQueuedNow(queued.id);
		const closing = session.close();
		await assert.rejects(immediate, hasCode(KERNEL_ERROR_CODES.SESSION_CLOSED));
		await closing;
		assert.equal(session.state, "closed");
		assert.equal(f.calls.length, 0);
	});

	it("a failed cancellation leaves the selected input available for recovery", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const active = session.send(input("old"));
		const activeFailure = assert.rejects(active, /persistence/);
		await f.waitForCall(0);
		const queued = session.followUp(input("next"));
		assert.ok(queued.id);
		const immediate = session.sendQueuedNow(queued.id);
		const immediateFailure = assert.rejects(immediate, /persistence/);
		f.calls[0].completion.reject(new KernelError(KERNEL_ERROR_CODES.TURN_PERSISTENCE, "persistence failure"));
		await Promise.all([activeFailure, immediateFailure]);
		assert.equal(session.state, "recovery_required");
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [queued.id]);
	});

	it("cancelled queued operations do not start the next message even if they ignore abort", async () => {
		const f = fixture();
		const operation = deferred<void>();
		let signal: AbortSignal | undefined;
		const session = await createAgentSession({
			id: "session", pipeline: f.pipeline,
			onQueueOperation: async (_operation, value) => { signal = value; await operation.promise; },
		});
		session.queueOperation({ type: "context.compact" });
		const queued = session.followUp(input("later"));
		const stop = session.cancel("stop");
		assert.equal(signal?.aborted, true);
		operation.resolve();
		await stop;
		assert.equal(f.calls.length, 0);
		assert.equal(session.state, "idle");
		assert.equal(session.listQueue().paused, true);
		assert.deepEqual(session.listQueue().entries.map((entry) => entry.id), [queued.id]);
	});

	it("failed queued operations pause the queue and report the failure", async () => {
		const f = fixture();
		const operation = deferred<void>();
		const reported = deferred<unknown>();
		const session = await createAgentSession({
			id: "session", pipeline: f.pipeline,
			onQueueOperation: () => operation.promise,
			onQueueOperationError: (_operation, error) => { reported.resolve(error); },
		});
		session.queueOperation({ type: "context.compact" });
		session.followUp(input("later"));
		operation.reject(new Error("compaction failed"));
		assert.match(String(await reported.promise), /compaction failed/);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.equal(f.calls.length, 0);
		assert.equal(session.listQueue().paused, true);
		assert.equal(session.pendingMessageCount, 1);
	});

	it("successful queued operations still advance the queue", async () => {
		const f = fixture();
		const operation = deferred<void>();
		const session = await createAgentSession({
			id: "session", pipeline: f.pipeline, onQueueOperation: () => operation.promise,
		});
		session.queueOperation({ type: "context.compact" });
		session.followUp(input("later"));
		operation.resolve();
		await f.waitForCall(0);
		assert.equal(f.calls[0].input?.message.content, "later");
		f.calls[0].completion.resolve(completed());
		await session.cancel();
		assert.equal(session.state, "idle");
	});

	it("unknown send-now IDs never cancel an active turn", async () => {
		const f = fixture();
		const session = await createAgentSession({ id: "session", pipeline: f.pipeline });
		const active = session.send(input("old"));
		await f.waitForCall(0);
		assert.deepEqual(await session.sendQueuedNow("missing"), { status: "missing" });
		assert.equal(f.calls[0].signal.aborted, false);
		f.calls[0].completion.resolve(completed());
		await active;
	});
});
