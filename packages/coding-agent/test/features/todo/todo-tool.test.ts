import type { RuntimeToolDefinition } from "@vetta/runtime-core/kernel";
import { describe, expect, it } from "vitest";
import { TodoState } from "../../../src/features/todo/todo-state.js";
import {
	createTodoToolRegistration,
	TODO_TOOL_CATEGORY,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_SCOPES,
	type TodoToolInput,
	TodoToolInputSchema,
} from "../../../src/features/todo/tool/index.js";

describe("Coding Agent Todo Tool", () => {
	it("owns the stable Tool definition and registration metadata", () => {
		const registration = createTodoToolRegistration({ getTodoStore: () => new TodoState() });

		expect({
			name: registration.tool.name,
			label: registration.tool.label,
			description: registration.tool.description,
			schema: registration.tool.inputSchema,
			scopeUse: registration.scopeUse,
			category: registration.category,
		}).toEqual({
			name: "todo",
			label: "todo",
			description: TODO_TOOL_DESCRIPTION,
			schema: TodoToolInputSchema,
			scopeUse: TODO_TOOL_SCOPES,
			category: TODO_TOOL_CATEGORY,
		});
	});

	it("preserves creation, update, listing, and clear behavior", async () => {
		const state = new TodoState();
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;
		const results = [];
		for (const input of [
			{ action: "create" as const, items: ["First", "Second"] },
			{ action: "update" as const, id: 1, status: "in_progress" as const },
			{ action: "list" as const },
			{ action: "clear" as const },
		]) {
			results.push(await executeTodo(tool, input));
		}

		expect(results.map((result) => result.details)).toEqual([
			{ action: "create" },
			{ action: "update" },
			{ action: "list" },
			{ action: "clear" },
		]);
		expect(results[0]?.content[0]).toMatchObject({ text: expect.stringContaining("Created 2 todo items") });
		expect(results[1]?.content[0]).toMatchObject({ text: expect.stringContaining("Updated #1 → in_progress") });
		expect(results[2]?.content[0]).toMatchObject({ text: expect.stringContaining("[~] #1 First") });
		expect(results[3]?.content[0]).toMatchObject({ text: expect.stringContaining("Cleared all todo items") });
		expect(state.getAll()).toEqual([]);
	});

	it("keeps scene-owned plans locked and sequential", async () => {
		const state = new TodoState();
		state.createMany(["First", "Second"]);
		state.lock("scene");
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;

		const skipped = await executeTodo(tool, { action: "update", id: 2, status: "done" });
		const cleared = await executeTodo(tool, { action: "clear" });

		expect(skipped.content[0]).toMatchObject({ text: expect.stringContaining("earlier items are not done") });
		expect(cleared.content[0]).toMatchObject({ text: expect.stringContaining("locked by scene") });
		expect(state.getAll()).toEqual([
			{ id: 1, content: "First", status: "pending" },
			{ id: 2, content: "Second", status: "pending" },
		]);
	});

	it("atomically replaces a plan and preserves identities for retained steps", async () => {
		const state = new TodoState();
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;
		await executeTodo(tool, { action: "create", items: ["Read", "Implement", "Verify"] });
		const observations: unknown[] = [];
		state.subscribe((items) => observations.push(structuredClone(items)));
		const result = await executeTodo(tool, {
			action: "replace",
			plan: [
				{ content: "Read", status: "done" },
				{ content: "Implement", status: "in_progress" },
				{ content: "Regression tests", status: "pending" },
			],
		});
		expect(result?.details).toEqual({ action: "replace" });
		expect(state.getAll()).toEqual([
			{ id: 1, content: "Read", status: "done" },
			{ id: 2, content: "Implement", status: "in_progress" },
			{ id: 4, content: "Regression tests", status: "pending" },
		]);
		expect(observations).toEqual([state.getAll()]);
	});

	it("rejects invalid whole-plan updates without changing any item", async () => {
		const state = new TodoState();
		state.createMany(["Original"]);
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;
		for (const plan of [
			[{ content: "  ", status: "pending" as const }],
			[
				{ content: "A", status: "in_progress" as const },
				{ content: "B", status: "in_progress" as const },
			],
		]) {
			const result = await executeTodo(tool, { action: "replace", plan });
			expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("REJECTED") });
			expect(state.getAll()).toEqual([{ id: 1, content: "Original", status: "pending" }]);
		}
	});

	it("updates a scene plan atomically while keeping its steps and strict order", async () => {
		const state = new TodoState();
		state.createMany(["First", "Second"]);
		state.lock("scene");
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;
		for (const plan of [
			[{ content: "Replacement", status: "pending" as const }],
			[
				{ content: "First", status: "pending" as const },
				{ content: "Second", status: "done" as const },
			],
		]) {
			const result = await executeTodo(tool, { action: "replace", plan });
			expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("REJECTED") });
			expect(state.getAll().every((item) => item.status === "pending")).toBe(true);
		}
		await executeTodo(tool, {
			action: "replace",
			plan: [
				{ content: "First", status: "done" },
				{ content: "Second", status: "in_progress" },
			],
		});
		expect(state.getAll().map((item) => item.status)).toEqual(["done", "in_progress"]);
		expect(state.getLockSource()).toBe("scene");
	});

	it("does not mutate the plan when cancellation arrives before tool execution", async () => {
		const state = new TodoState();
		state.createMany(["Original"]);
		const tool = createTodoToolRegistration({ getTodoStore: () => state }).tool;
		const controller = new AbortController();
		controller.abort(new Error("cancelled plan update"));
		await expect(
			tool.execute({
				sessionId: "session",
				turnId: "turn",
				toolCallId: "cancelled-plan",
				input: { description: "Replace the plan", action: "replace", plan: [] },
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled plan update");
		expect(state.getAll()).toEqual([{ id: 1, content: "Original", status: "pending" }]);
	});
});

function executeTodo(tool: RuntimeToolDefinition<TodoToolInput>, input: TodoToolInput) {
	return tool.execute({
		sessionId: "session",
		turnId: "turn",
		toolCallId: "todo",
		input,
		signal: new AbortController().signal,
	});
}
