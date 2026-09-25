import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionRuntimeBackendReply } from "../../../../shared/session-runtime-backend";
import { applyInitialRuntimeBackend } from "./initial-runtime-backend";

const native: SessionRuntimeBackendReply = {
	ok: true,
	state: { sessionId: "session", backend: "native", selectionId: "default", busy: false, switching: false },
};
describe("first instruction runtime selection", () => {
	it("confirms Codex before the caller may dispatch its first instruction", async () => {
		const actions: string[] = [];
		await applyInitialRuntimeBackend(
			{
				getRuntimeBackend: async () => native,
				setRuntimeBackend: async (_id, backend, expected) => {
					actions.push("select");
					assert.equal(backend, "codex");
					assert.equal(expected, "default");
					return { ok: true, state: { ...native.state, backend: "codex", selectionId: "selected" } };
				},
			},
			"session",
			"codex",
		);
		actions.push("send");
		assert.deepEqual(actions, ["select", "send"]);
	});
	it("does not let failed selection fall back to a Native send", async () => {
		let sent = false;
		await assert.rejects(
			(async () => {
				await applyInitialRuntimeBackend(
					{
						getRuntimeBackend: async () => native,
						setRuntimeBackend: async () => ({ ok: false, code: "RESPONSES_REQUIRED" }),
					},
					"session",
					"codex",
				);
				sent = true;
			})(),
			/RESPONSES_REQUIRED/,
		);
		assert.equal(sent, false);
	});
	it("does not change existing-call behavior when no initial selection was supplied", async () => {
		const fail = async (): Promise<SessionRuntimeBackendReply> => {
			throw new Error("must not read");
		};
		await applyInitialRuntimeBackend({ getRuntimeBackend: fail, setRuntimeBackend: fail }, "session");
	});
});
