import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { startCodexProviderBridge } from "@vetta/runtime-node/codex-app-server";
import type { RuntimeSessionTurnControl, RuntimeTurnPromptOutcome } from "@vetta/runtime-core";
import { WorkspaceTurnAdmission } from "./turn-admission.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}

function runtime() {
	const started = deferred<void>();
	const result = deferred<RuntimeTurnPromptOutcome>();
	const stopReceived = deferred<void>();
	const acknowledged = deferred<void>();
	let dispatches = 0;
	let stops = 0;
	let signal: AbortSignal | undefined;
	const control: Pick<RuntimeSessionTurnControl, "promptWhenAvailable" | "abort"> = {
		promptWhenAvailable: (_input, incoming) => {
			dispatches++; signal = incoming; started.resolve(); return result.promise;
		},
		abort: async () => { stops++; stopReceived.resolve(); await acknowledged.promise; },
	};
	return { control, started, result, stopReceived, acknowledged,
		counts: () => ({ dispatches, stops }), signal: () => signal };
}

async function gateway() {
	const entered = deferred<void>();
	const release = deferred<void>();
	let blocked = false;
	const target = { identity: "model", revision: "credential", model: "test", baseUrl: "https://fixture.invalid/v1", headers: {} };
	const bridge = await startCodexProviderBridge({
		resolve: async () => { if (blocked) { entered.resolve(); await release.promise; } return target; },
		fetch: async () => { throw new Error("No external network allowed in admission tests"); },
	});
	return { bridge, entered, release, block: () => { blocked = true; }, unblock: () => { blocked = false; release.resolve(); } };
}

describe("Codex preparation and dispatch share cancellation ownership", () => {
	it("stops during credential loading without waiting for it, then permits a new successful turn", async () => {
		const source = await gateway(); const remote = runtime();
		const turns = new WorkspaceTurnAdmission(remote.control, signal => source.bridge.assertCurrent(signal));
		try {
			source.block(); const pending = turns.prompt("inspect"); await source.entered.promise;
			await turns.stop(); assert.deepEqual(await pending, { status: "cancelled" });
			assert.deepEqual(remote.counts(), { dispatches: 0, stops: 0 });
			assert.equal(turns.requiresRecovery(), false);
			source.unblock();
			const next = turns.prompt("new instruction"); await remote.started.promise;
			remote.result.resolve({ status: "completed", turnId: "next" });
			assert.deepEqual(await next, { status: "completed" });
			assert.equal(remote.counts().dispatches, 1);
		} finally { source.unblock(); await turns.close(() => source.bridge.close()); }
	});

	it("an immediate stop cancels accepted work before any preparation or dispatch", async () => {
		const remote = runtime(); let preparations = 0;
		const turns = new WorkspaceTurnAdmission(remote.control, async () => { preparations++; });
		const pending = turns.prompt("inspect"); const first = turns.stop();
		assert.equal(turns.stop(), first); await first;
		assert.deepEqual(await pending, { status: "cancelled" });
		assert.equal(preparations, 0); assert.equal(remote.counts().dispatches, 0);
	});

	it("rejects concurrent instructions while the first one is still preparing", async () => {
		const source = await gateway(); const remote = runtime();
		const turns = new WorkspaceTurnAdmission(remote.control, signal => source.bridge.assertCurrent(signal));
		try {
			source.block(); const pending = turns.prompt("first"); await source.entered.promise;
			await assert.rejects(turns.prompt("second"), { code: "BUSY" });
			await turns.stop(); await pending; assert.equal(remote.counts().dispatches, 0);
		} finally { source.unblock(); await turns.close(() => source.bridge.close()); }
	});

	it("closing during credential loading cancels preparation and preserves the close barrier", async () => {
		const source = await gateway(); const remote = runtime();
		const turns = new WorkspaceTurnAdmission(remote.control, signal => source.bridge.assertCurrent(signal));
		try {
			source.block(); const pending = turns.prompt("first"); await source.entered.promise;
			const closing = turns.close(() => source.bridge.close());
			assert.equal(turns.close(async () => { throw new Error("must not run twice"); }), closing);
			await closing; assert.deepEqual(await pending, { status: "cancelled" });
			source.unblock();
			await assert.rejects(turns.prompt("late"), { code: "CLOSED" });
			assert.equal(remote.counts().dispatches, 0);
		} finally { source.unblock(); await source.bridge.close(); }
	});

	it("a stop acknowledgement alone never settles a dispatched task", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const pending = turns.prompt("work"); await remote.started.promise;
		const stop = turns.stop(); await remote.stopReceived.promise;
		assert.equal(remote.signal()?.aborted, true);
		remote.acknowledged.resolve();
		await assert.rejects(turns.prompt("premature next"), { code: "BUSY" });
		remote.result.resolve({ status: "cancelled", turnId: "first" });
		await stop; assert.deepEqual(await pending, { status: "cancelled" });
	});

	it("retains ownership until stop cleanup ends even if terminal output arrives first", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const pending = turns.prompt("work"); await remote.started.promise;
		const stop = turns.stop(); await remote.stopReceived.promise;
		remote.result.resolve({ status: "completed", turnId: "first" });
		assert.deepEqual(await pending, { status: "completed" });
		await assert.rejects(turns.prompt("too soon"), { code: "BUSY" });
		remote.acknowledged.resolve(); await stop;
		assert.deepEqual(await turns.prompt("now accepted"), { status: "completed" });
		assert.equal(remote.counts().stops, 1);
	});

	it("does not report cancellation when execution fails after a stop was requested", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const pending = turns.prompt("work"); await remote.started.promise;
		const stop = turns.stop(); await remote.stopReceived.promise; remote.acknowledged.resolve();
		const failure = new Error("outcome unknown");
		const taskRejected = assert.rejects(pending, failure); const stopRejected = assert.rejects(stop, failure);
		remote.result.reject(failure); await Promise.all([taskRejected, stopRejected]);
		assert.equal(turns.requiresRecovery(), true);
		await assert.rejects(turns.prompt("implicit replay"), { code: "RECOVERY_REQUIRED" });
	});

	it("a definite provider failure keeps its failure status rather than becoming a cancelled task", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const pending = turns.prompt("work"); await remote.started.promise;
		const stop = turns.stop(); await remote.stopReceived.promise; remote.acknowledged.resolve();
		remote.result.resolve({ status: "failed", error: { code: "PROVIDER_ERROR", message: "fixture", retryable: false, origin: "provider" } });
		assert.deepEqual(await pending, { status: "failed", errorCode: "PROVIDER_ERROR" }); await stop;
	});

	it("a failed credential check blocks dispatch and requires an explicit new owner", async () => {
		const remote = runtime(); const failure = new Error("credentials unavailable");
		const turns = new WorkspaceTurnAdmission(remote.control, async () => { throw failure; });
		await assert.rejects(turns.prompt("work"), failure);
		await assert.rejects(turns.prompt("retry"), { code: "RECOVERY_REQUIRED" });
		assert.equal(remote.counts().dispatches, 0);
	});

	it("never treats an unsupported or missing runtime result as success", async () => {
		const control: Pick<RuntimeSessionTurnControl, "promptWhenAvailable" | "abort"> = {
			promptWhenAvailable: async () => undefined, abort: async () => {},
		};
		const turns = new WorkspaceTurnAdmission(control);
		await assert.rejects(turns.prompt("work"), { code: "OUTCOME_UNKNOWN" });
		assert.equal(turns.requiresRecovery(), true);
	});

	it("retains a rejected resource-close promise and blocks reopening", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const failure = new Error("process exit unconfirmed");
		const closing = turns.close(async () => { throw failure; });
		await assert.rejects(closing, failure);
		assert.equal(turns.close(async () => {}), closing);
		await assert.rejects(turns.prompt("work"), { code: "CLOSED" });
	});
	it("reports failed process cleanup without waiting forever for that process's task result", async () => {
		const remote = runtime(); const turns = new WorkspaceTurnAdmission(remote.control);
		const pending = turns.prompt("work"); await remote.started.promise;
		const failure = new Error("process cannot be stopped");
		try {
			await assert.rejects(turns.close(async () => { throw failure; }), failure);
			await assert.rejects(turns.prompt("replacement"), { code: "CLOSED" });
		} finally {
			remote.result.resolve({ status: "failed", error: { code: "OUTCOME_UNKNOWN", message: "fixture", origin: "runtime", retryable: false } });
			await pending;
		}
	});

});
