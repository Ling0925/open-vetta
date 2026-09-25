import assert from "node:assert/strict";
import type { CodingAgentSandboxAuthorizationFunctionRequest } from "@vetta/coding-agent/function-extensions";
import { describe, it } from "vitest";
import { DesktopSandboxAuthorizationBroker } from "./sandbox-authorization-broker.js";

describe("permission request completion", () => {
	it("notifies the original drawer when cancellation resolves the pending request", async () => {
		const broker = new DesktopSandboxAuthorizationBroker();
		const events: unknown[] = [];
		broker.onResolved((event) => events.push(event));
		broker.setInteractiveHandler(
			(_request, signal) =>
				new Promise((resolve) => signal?.addEventListener("abort", () => resolve("deny"), { once: true })),
		);
		const controller = new AbortController();
		const pending = broker.handle(
			{ requestId: "permission", sessionId: "session" } as CodingAgentSandboxAuthorizationFunctionRequest,
			controller.signal,
		);
		controller.abort();
		assert.equal(await pending, "deny");
		assert.deepEqual(events, [{ requestId: "permission", sessionId: "session" }]);
	});
	it("observer failures cannot approve a rejected operation", async () => {
		const broker = new DesktopSandboxAuthorizationBroker();
		broker.onResolved(() => {
			throw new Error("observer");
		});
		broker.setInteractiveHandler(async () => "deny");
		assert.equal(
			await broker.handle({
				requestId: "permission",
				sessionId: "session",
			} as CodingAgentSandboxAuthorizationFunctionRequest),
			"deny",
		);
	});
});
