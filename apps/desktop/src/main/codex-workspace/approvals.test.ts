import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CodexWorkspaceApprovals } from "./approvals.js";
const request = (signal = new AbortController().signal, params = {}) => ({ method: "item/fileChange/requestApproval", params, signal });
describe("Codex approval grants", () => {
	it("settles one request once and never grants session-wide permission", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { }); const pending = approvals.request(request(), "s", "i");
		const id = approvals.list()[0].id; approvals.decide(id, "accept", "s", "i"); assert.equal(await pending, "accept");
		assert.throws(() => approvals.decide(id, "accept", "s", "i"), { code: "APPROVAL_EXPIRED" });
	});
	it("invalidates a late accept after the runtime aborts the request", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { }); const controller = new AbortController();
		const pending = approvals.request(request(controller.signal), "s", "i"); const id = approvals.list()[0].id;
		controller.abort(); assert.equal(await pending, "cancel");
		assert.throws(() => approvals.decide(id, "accept", "s", "i"), { code: "APPROVAL_EXPIRED" });
	});
	it("rejects an approval belonging to another input or session", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { }); const pending = approvals.request(request(), "s", "i");
		assert.throws(() => approvals.decide(approvals.list()[0].id, "accept", "s", "other"), { code: "APPROVAL_EXPIRED" });
		assert.equal(await pending, "cancel");
	});
	it("declines oversized payloads rather than granting against truncated details", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { });
		assert.equal(await approvals.request(request(undefined, { diff: "x".repeat(70000) }), "s", "i"), "decline");
		assert.equal(approvals.list().length, 0);
	});
	it("times out an unattended approval without accepting it", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { }, 1);
		assert.equal(await approvals.request(request(), "s", "i"), "decline"); assert.equal(approvals.list().length, 0);
	});
	it("does not mutate the displayed request when the caller changes its original object", async () => {
		const approvals = new CodexWorkspaceApprovals(() => { }); const params = { command: "read" };
		const pending = approvals.request(request(undefined, params), "s", "i"); params.command = "write";
		assert.equal(JSON.parse(approvals.list()[0].details).command, "read"); approvals.cancelAll(); await pending;
	});
});
