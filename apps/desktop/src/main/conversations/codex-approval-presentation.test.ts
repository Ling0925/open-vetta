import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { codexApprovalPresentation, codexApprovalRequestId } from "./codex-approval-presentation.js";

describe("Codex approval presentation", () => {
	it("surfaces the exact command and working directory without changing the approval type", () => {
		assert.deepEqual(
			codexApprovalPresentation(
				{
					method: "item/commandExecution/requestApproval",
					params: { command: "rm -rf ./generated", cwd: "/repo" },
				},
				"/fallback",
			),
			{
				kind: "command",
				toolName: "codex.commandExecution",
				command: "rm -rf ./generated",
				cwd: "/repo",
				paths: [],
			},
		);
	});

	it("summarizes changed paths and removes duplicates", () => {
		assert.deepEqual(
			codexApprovalPresentation(
				{
					method: "item/fileChange/requestApproval",
					params: {
						changes: [{ path: "/repo/a.ts" }, { file_path: "/repo/b.ts" }, { path: "/repo/a.ts" }],
					},
				},
				"/repo",
			),
			{
				kind: "file-change",
				toolName: "codex.fileChange",
				cwd: "/repo",
				paths: ["/repo/a.ts", "/repo/b.ts"],
			},
		);
	});

	it("derives a stable opaque drawer id from Codex request identity, not command text", () => {
		const base = {
			id: "vetta:7",
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "thread-a",
				turnId: "turn-a",
				itemId: "item-a",
				command: "echo secret-looking-payload",
			},
		};
		const first = codexApprovalRequestId("session-a", base);
		const sameIdentity = codexApprovalRequestId("session-a", {
			...base,
			params: { ...base.params, command: "different command" },
		});
		const nextItem = codexApprovalRequestId("session-a", {
			...base,
			params: { ...base.params, itemId: "item-b" },
		});
		assert.equal(first, sameIdentity);
		assert.notEqual(first, nextItem);
		assert.match(first, /^codex:[a-f0-9]{32}$/);
		assert.equal(first.includes("secret-looking-payload"), false);
	});

	it("falls back conservatively for unknown request methods", () => {
		assert.deepEqual(
			codexApprovalPresentation({ method: "item/future/requestApproval", params: {} }, "/repo"),
			{
				kind: "other",
				toolName: "codex.item/future/requestApproval",
				cwd: "/repo",
				paths: [],
			},
		);
	});
});
