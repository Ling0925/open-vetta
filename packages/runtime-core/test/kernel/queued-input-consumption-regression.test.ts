import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Message } from "@vetta/ai";
import type { QueuedSessionInput, TurnInputQueue } from "../../src/kernel/contracts.js";
import { consumeQueuedInputBatch } from "../../src/kernel/queued-input-consumption.js";
import { SessionInputQueue } from "../../src/kernel/session-input-queue.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}
function messages(inputs: readonly QueuedSessionInput[]): Promise<Message[]> {
	return Promise.resolve(inputs.flatMap((input) => input.message ? [input.message] : []));
}
function add(queue: SessionInputQueue, text: string) {
	return queue.enqueueWithId("followUp", { message: { role: "user", content: text, timestamp: 1 } });
}

describe("queued input reservation regressions", () => {
	it("retains the whole batch with original IDs when preparation fails", async () => {
		const queue = new SessionInputQueue({ followUpMode: "all" });
		add(queue, "a"); add(queue, "b");
		const before = queue.list();
		await assert.rejects(consumeQueuedInputBatch(queue, "followUp", async () => {
			throw new Error("input preparation failed");
		}, new AbortController().signal), /input preparation failed/);
		assert.deepEqual(queue.list(), before);
		assert.equal(queue.takeFollowUpInputs().length, 2);
	});

	it("keeps reserved inputs in snapshots and blocks duplicate consumption", async () => {
		const queue = new SessionInputQueue();
		const a = add(queue, "a");
		const gate = deferred<Message[]>();
		const work = consumeQueuedInputBatch(queue, "followUp", () => gate.promise, new AbortController().signal);
		assert.deepEqual(queue.list().entries.map((entry) => entry.id), [a.id]);
		assert.deepEqual(queue.takeFollowUpInputs(), []);
		assert.equal(queue.takeById(a.id), undefined);
		gate.resolve([{ role: "user", content: "a", timestamp: 1 }]);
		assert.equal((await work).length, 1);
		assert.equal(queue.pendingCount, 0);
	});

	it("releases immediately on abort and rejects late preparation results", async () => {
		const queue = new SessionInputQueue();
		const a = add(queue, "a");
		const gate = deferred<Message[]>();
		const controller = new AbortController();
		const work = consumeQueuedInputBatch(queue, "followUp", () => gate.promise, controller.signal);
		const failure = assert.rejects(work, /stop/);
		controller.abort(new Error("stop"));
		const reservation = queue.reserveById(a.id);
		assert.ok(reservation);
		reservation.release();
		gate.resolve([]);
		await failure;
		assert.deepEqual(queue.list().entries.map((entry) => entry.id), [a.id]);
	});

	it("does not resurrect a message explicitly removed while being prepared", async () => {
		const queue = new SessionInputQueue();
		const a = add(queue, "a");
		const gate = deferred<Message[]>();
		const work = consumeQueuedInputBatch(queue, "followUp", () => gate.promise, new AbortController().signal);
		assert.equal(queue.remove(a.id), true);
		gate.resolve([{ role: "user", content: "a", timestamp: 1 }]);
		await assert.rejects(work, /changed during preparation/);
		assert.equal(queue.pendingCount, 0);
	});

	it("does not delete replacement entries after a queue snapshot is restored", async () => {
		const queue = new SessionInputQueue();
		add(queue, "a");
		const snapshot = queue.list();
		const reservation = queue.reserveFollowUpInputs();
		queue.restore(snapshot);
		assert.equal(reservation.commit(), false);
		assert.deepEqual(queue.list(), snapshot);
	});

	it("respects pause, one-at-a-time, and queued operation barriers", async () => {
		const queue = new SessionInputQueue({ followUpMode: "all" });
		add(queue, "before");
		queue.enqueueOperationWithId({ type: "context.compact" });
		const after = add(queue, "after");
		queue.pause();
		assert.deepEqual(await consumeQueuedInputBatch(queue, "followUp", messages, new AbortController().signal), []);
		queue.resume();
		assert.equal((await consumeQueuedInputBatch(queue, "followUp", messages, new AbortController().signal)).length, 1);
		assert.equal(queue.reserveById(after.id), undefined);
		assert.deepEqual(await consumeQueuedInputBatch(queue, "followUp", messages, new AbortController().signal), []);
		assert.ok(queue.takeFollowUpOperationHead());
		queue.setFollowUpMode("one-at-a-time");
		add(queue, "last");
		assert.equal((await consumeQueuedInputBatch(queue, "followUp", messages, new AbortController().signal)).length, 1);
		assert.equal(queue.pendingCount, 1);
	});

	it("supports steering reservations and commits only once", async () => {
		const queue = new SessionInputQueue();
		queue.enqueueWithId("steer", { message: { role: "user", content: "steer", timestamp: 1 } });
		assert.equal((await consumeQueuedInputBatch(queue, "steer", messages, new AbortController().signal)).length, 1);
		add(queue, "next");
		const reservation = queue.reserveFollowUpInputs();
		assert.equal(reservation.commit(), true);
		assert.equal(reservation.commit(), false);
		reservation.release();
		assert.equal(queue.pendingCount, 0);
	});

	it("preserves compatibility with legacy queue ports", async () => {
		const queue: TurnInputQueue = {
			takeSteering: () => [],
			takeFollowUps: () => [{ role: "user", content: "legacy", timestamp: 1 }],
			enqueueFollowUps: () => {},
		};
		const result = await consumeQueuedInputBatch(queue, "followUp", messages, new AbortController().signal);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].content, "legacy");
	});
});
