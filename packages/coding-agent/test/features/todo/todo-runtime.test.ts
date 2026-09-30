import {
	applyConversationDocumentCommand,
	type ConversationDocument,
	createEmptyConversationDocument,
} from "@vetta/runtime-core";
import { describe, expect, it, vi } from "vitest";
import { CodingAgentTodoRuntime } from "../../../src/features/todo/todo-runtime.js";
import { createCodingAgentTodoRuntimeToolRegistration } from "../../../src/features/todo/todo-tool-feature.js";

describe("CodingAgentTodoRuntime", () => {
	it("persists one complete plan revision and restores it without an empty intermediate state", async () => {
		let document = createEmptyConversationDocument({ sessionId: "plan-session", createdAt: 1 });
		let entryIndex = 0;
		const runtime = new CodingAgentTodoRuntime({ createEntryId: () => `plan-${++entryIndex}`, now: () => 1 });
		runtime.initialize(document, {
			appendCustomEntry: async (entry) => {
				document = applyConversationDocumentCommand(document, { type: "custom.append", ...entry }).document;
				runtime.onDocumentChanged(document);
			},
		});
		const tool = createCodingAgentTodoRuntimeToolRegistration(runtime).tool;
		const replace = (plan: { content: string; status: "pending" | "in_progress" | "done" }[]) =>
			tool.execute({
				sessionId: "plan-session",
				turnId: "turn-1",
				toolCallId: `plan-call-${entryIndex}`,
				input: { description: "Update the execution plan", action: "replace", plan },
				signal: new AbortController().signal,
			});
		try {
			await replace([
				{ content: "Read", status: "in_progress" },
				{ content: "Test", status: "pending" },
			]);
			await replace([
				{ content: "Read", status: "done" },
				{ content: "Test", status: "in_progress" },
			]);
			expect(document.entries.filter((entry) => entry.type === "custom")).toHaveLength(2);
			const restored = new CodingAgentTodoRuntime();
			try {
				restored.initialize(document, { appendCustomEntry: async () => undefined });
				expect(restored.readItems()).toEqual([
					{ id: 1, content: "Read", status: "done" },
					{ id: 2, content: "Test", status: "in_progress" },
				]);
			} finally {
				await restored.dispose();
			}
		} finally {
			await runtime.dispose();
		}
	});

	it("shares one store across Runtime Tool, persistence and Controller", async () => {
		let document = createEmptyConversationDocument({ sessionId: "session-1", createdAt: 1 });
		let entryIndex = 0;
		const runtime = new CodingAgentTodoRuntime({
			createEntryId: () => `todo-snapshot-${++entryIndex}`,
			now: () => 1,
		});
		runtime.initialize(document, {
			appendCustomEntry: async (entry) => {
				document = applyConversationDocumentCommand(document, {
					type: "custom.append",
					...entry,
				}).document;
				await runtime.onDocumentChanged(document);
			},
		});
		const registration = createCodingAgentTodoRuntimeToolRegistration(runtime);

		const result = await registration.tool.execute({
			sessionId: "session-1",
			turnId: "turn-1",
			toolCallId: "todo-call-1",
			input: {
				description: "Create an implementation plan",
				action: "create",
				items: ["Implement"],
			},
			signal: new AbortController().signal,
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: "Created 1 todo items:\n  #1 Implement\n\n[ ] #1 Implement\n\nProgress: 0/1 completed",
			},
		]);
		expect(runtime.getAll()).toEqual([{ id: 1, content: "Implement", status: "pending" }]);
		expect(runtime.readItems()).toEqual([{ id: 1, content: "Implement", status: "pending" }]);
		expect(document.entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "todo_snapshot",
			data: {
				items: [{ id: 1, content: "Implement", status: "pending" }],
				lockedBy: null,
			},
		});
		expect(runtime.clear()).toBe(true);
		await runtime.flush();
		expect(runtime.readItems()).toEqual([]);
		await runtime.dispose();
	});

	it("restores the latest snapshot from the selected branch", () => {
		const runtime = new CodingAgentTodoRuntime();
		const root = createEmptyConversationDocument({ sessionId: "session-1", createdAt: 1 });
		const firstBranch = appendSnapshot(root, "branch-a", "First", "pending");
		const secondBranch = appendSnapshot({ ...firstBranch, activeLeafId: null }, "branch-b", "Second", "done");
		runtime.initialize(secondBranch, {
			appendCustomEntry: async () => undefined,
		});

		expect(runtime.readItems()).toEqual([{ id: 1, content: "Second", status: "done" }]);

		runtime.onDocumentChanged({ ...secondBranch, activeLeafId: "branch-a" });
		expect(runtime.readItems()).toEqual([{ id: 1, content: "First", status: "pending" }]);
	});

	it("rejects malformed persisted snapshots at the storage boundary", () => {
		const runtime = new CodingAgentTodoRuntime();
		const malformed = applyConversationDocumentCommand(
			createEmptyConversationDocument({ sessionId: "session-1", createdAt: 1 }),
			{
				type: "custom.append",
				entryId: "invalid",
				customType: "todo_snapshot",
				data: { items: [{ id: "wrong" }], lockedBy: null },
				timestamp: "2026-07-28T00:00:00.000Z",
			},
		).document;

		expect(() =>
			runtime.initialize(malformed, {
				appendCustomEntry: vi.fn(async () => undefined),
			}),
		).toThrow("Invalid todo_snapshot entry: invalid");
	});
});

function appendSnapshot(
	document: ConversationDocument,
	entryId: string,
	content: string,
	status: "pending" | "done",
): ConversationDocument {
	return applyConversationDocumentCommand(document, {
		type: "custom.append",
		entryId,
		customType: "todo_snapshot",
		data: {
			items: [{ id: 1, content, status }],
			lockedBy: null,
		},
		timestamp: "2026-07-28T00:00:00.000Z",
	}).document;
}
