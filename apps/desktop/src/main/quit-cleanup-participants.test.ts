import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { registerQuitCleanupParticipant, resetQuitCleanupForTest, runQuitCleanup, setQuitCleanup, isQuitCleanupStarted } from "./quit-cleanup.js";
afterEach(resetQuitCleanupForTest);
describe("owned runtimes participate in application quit", () => {
	it("all callers wait for process disposal and main cleanup", async () => {
		let release!: () => void; let finished = false; let calls = 0;
		registerQuitCleanupParticipant(() => new Promise(resolve => { release = resolve; }));
		setQuitCleanup(async () => { calls++; });
		const first = runQuitCleanup(); const second = runQuitCleanup().then(() => { finished = true; });
		assert.equal(isQuitCleanupStarted(), true); await Promise.resolve(); assert.equal(finished, false);
		release(); await Promise.all([first, second]); assert.equal(finished, true); assert.equal(calls, 1);
	});
	it("tries every cleanup even when one fails and propagates failure", async () => {
		let called = false; registerQuitCleanupParticipant(async () => { throw new Error("not stopped"); });
		setQuitCleanup(async () => { called = true; }); await assert.rejects(runQuitCleanup(), AggregateError); assert.equal(called, true);
	});
	it("supports unregistering a successfully disposed optional runtime", async () => {
		let called = false; const remove = registerQuitCleanupParticipant(async () => { called = true; }); remove();
		await runQuitCleanup(); assert.equal(called, false);
		assert.throws(() => registerQuitCleanupParticipant(async () => { }), /shutdown/);
	});
});
