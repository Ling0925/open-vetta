import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { codexApprovalPresentation } from "./codex-approval-presentation.js";

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
