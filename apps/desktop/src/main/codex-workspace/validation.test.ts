import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { command, profile, errorCode } from "./validation.js";
import { isCodexWorkspaceSender, replacesMainDocument } from "./sender-policy.js";
describe("local Codex boundary", () => {
	it("requires the exact configured top-level renderer and owner", () => {
		const expected = "file:///app/renderer/index.html";
		assert.equal(isCodexWorkspaceSender({ owner: true, mainFrame: true, url: `${expected}#/codex` }, expected), true);
		for (const actual of [{ owner: false, mainFrame: true, url: expected }, { owner: true, mainFrame: false, url: expected },
		{ owner: true, mainFrame: true, url: "file:///other/index.html" }, { owner: true, mainFrame: true, url: "https://evil.test" }]) {
			assert.equal(isCodexWorkspaceSender(actual, expected), false);
		}
	});
	it("does not trust any local web page or the dev server's other paths", () => {
		assert.equal(isCodexWorkspaceSender({ owner: true, mainFrame: true, url: "http://localhost:5173/other" }, "http://localhost:5173/"), false);
		assert.equal(isCodexWorkspaceSender({ owner: true, mainFrame: true, url: "http://localhost:5173/#/codex" }, "http://localhost:5173/"), true);
	});
	it("rejects relative executables, shell options, unexpected fields and control characters", () => {
		const valid = { executable: "/trusted/codex", expectedVersion: "1.2.3", codexHome: "/private/codex", cwd: "/work", sandbox: "read-only" };
		assert.deepEqual(profile(valid), valid);
		for (const patch of [{ executable: "codex" }, { cwd: "/work\nspoof" }, { expectedVersion: "latest" }, { sandbox: "danger-full-access" }, { executableArgs: ["--evil"] }]) {
			assert.throws(() => profile({ ...valid, ...patch }));
		}
	});
	it("does not allow path injection via saved-session identifiers", () => {
		assert.throws(() => command({ type: "open", sessionId: "../other" }));
		assert.throws(() => command({ type: "send", sessionId: "s", inputId: "i", text: "work", model: "other" }));
	});
	it("returns only safe diagnostic codes, not secret-bearing error text", () => {
		assert.equal(errorCode(new Error("secret token")), "CODEX_UNAVAILABLE");
		assert.equal(errorCode({ code: "secret:token" }), "CODEX_UNAVAILABLE");
		assert.equal(errorCode({ code: "OUTCOME_UNKNOWN" }), "OUTCOME_UNKNOWN");
	});
	it("closes an old document owner on reload, but not same-document route changes or subframes", () => {
		assert.equal(replacesMainDocument({ isMainFrame: true, isSameDocument: false }), true);
		assert.equal(replacesMainDocument({ isMainFrame: true, isSameDocument: true }), false);
		assert.equal(replacesMainDocument({ isMainFrame: false, isSameDocument: false }), false);
		assert.equal(replacesMainDocument({}, false, true), true);
	});

});
