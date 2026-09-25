import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { startCodexProviderBridge } from "../../src/codex-app-server/provider-bridge.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}

async function fixture() {
	const loading = deferred<void>(); const resolver = deferred<void>();
	let blocking = false; let requests = 0; let invalidate = () => {};
	const target = { identity: "same-model", revision: "same-key", model: "fixture", baseUrl: "https://fixture.invalid/v1", headers: {} };
	const bridge = await startCodexProviderBridge({
		resolve: async () => { if (blocking) { loading.resolve(); await resolver.promise; } return target; },
		subscribe: listener => { invalidate = listener; return () => { invalidate = () => {}; }; },
		fetch: async () => { requests++; return new Response("{}", { headers: { "content-type": "application/json" } }); },
	});
	return { bridge, loading, resolver, block: () => { blocking = true; }, unblock: () => { blocking = false; resolver.resolve(); },
		requests: () => requests, invalidate: () => invalidate() };
}

describe("gateway cancellation while resolving configuration", () => {
	it("cancels a single read immediately without revoking a valid bridge", async () => {
		const f = await fixture(); const controller = new AbortController();
		try {
			f.block(); const pending = f.bridge.assertCurrent(controller.signal); await f.loading.promise;
			const cancelled = assert.rejects(pending, error => error === controller.signal.reason);
			controller.abort(); await cancelled;
			f.unblock(); await f.bridge.assertCurrent(); assert.equal(f.requests(), 0);
		} finally { f.unblock(); await f.bridge.close(); }
	});

	it("refuses an already-cancelled preflight without starting another configuration read", async () => {
		const f = await fixture(); const controller = new AbortController(); controller.abort();
		try {
			f.block(); await assert.rejects(f.bridge.assertCurrent(controller.signal), error => error === controller.signal.reason);
			f.unblock(); await f.bridge.assertCurrent();
		} finally { f.unblock(); await f.bridge.close(); }
	});

	it("closing the bridge settles an outstanding configuration read even if the resolver never answers", async () => {
		const f = await fixture();
		try {
			f.block(); const pending = assert.rejects(f.bridge.assertCurrent(), { code: "GATEWAY_CLOSED" });
			await f.loading.promise; await f.bridge.close(); await pending;
			assert.equal(f.requests(), 0);
		} finally { f.unblock(); await f.bridge.close(); }
	});

	it("a provider-change notification interrupts a pending read, not just requests already using fetch", async () => {
		const f = await fixture();
		try {
			f.block(); const pending = assert.rejects(f.bridge.assertCurrent(), { code: "MODEL_CONFIGURATION_CHANGED" });
			await f.loading.promise; f.invalidate(); await pending;
			f.unblock(); await assert.rejects(f.bridge.assertCurrent(), { code: "MODEL_CONFIGURATION_CHANGED" });
		} finally { f.unblock(); await f.bridge.close(); }
	});

	it("a late failing resolver cannot turn a cancelled read into an unhandled rejection", async () => {
		const f = await fixture(); const controller = new AbortController();
		try {
			f.block(); const pending = f.bridge.assertCurrent(controller.signal); await f.loading.promise;
			const cancelled = assert.rejects(pending, error => error === controller.signal.reason);
			controller.abort(); await cancelled;
			f.resolver.reject(new Error("late credential store failure"));
			// A new read is independent of the old resolver and must not see its failure.
			f.unblock(); await f.bridge.assertCurrent();
		} finally { f.unblock(); await f.bridge.close(); }
	});

	it("shutdown during a real HTTP request's credential lookup never forwards the request later", async () => {
		const f = await fixture();
		try {
			f.block();
			const response = fetch(`${f.bridge.provider.baseUrl}/responses`, {
				method: "POST", headers: { authorization: `Bearer ${f.bridge.provider.bearerToken}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "fixture", input: [] }),
			}).then(result => result.text(), () => "connection closed");
			await f.loading.promise; await f.bridge.close(); await response;
			f.unblock(); assert.equal(f.requests(), 0);
		} finally { f.unblock(); await f.bridge.close(); }
	});
});
