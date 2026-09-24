import assert from "node:assert/strict";
import { Type } from "@vetta/ai";
import { describe, it } from "vitest";
import { executeRuntimeToolCalls } from "../src/engine/tool-executor.js";
import type { AgentExecutionEvent, RuntimeToolDefinition, RuntimeToolResult } from "../src/engine/types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => { resolve = accept; });
	return { promise, resolve };
}
const result: RuntimeToolResult = { content: [{ type: "text", text: "ok" }], details: {} };
const call = (id: string) => ({ type: "toolCall" as const, id, name: "write", arguments: {} });
function tool(execute: RuntimeToolDefinition["execute"]): RuntimeToolDefinition {
	return { name: "write", description: "test", inputSchema: Type.Object({}), validateInput: (input) => input, execute };
}

describe("tool authorization cancellation regressions", () => {
	it("never starts a tool after cancellation during authorization", async () => {
		const controller = new AbortController();
		const authorized = deferred<void>();
		const waiting = deferred<void>();
		let executed = 0;
		const work = executeRuntimeToolCalls({
			calls: [call("a")], tools: [tool(async () => { executed += 1; return result; })],
			messages: [], modelCallIndex: 0, signal: controller.signal, emit: () => {},
			policy: { authorize: async () => { waiting.resolve(); await authorized.promise; } },
		});
		const rejection = assert.rejects(work, /stop/);
		await waiting.promise;
		controller.abort(new Error("stop"));
		authorized.resolve();
		await rejection;
		assert.equal(executed, 0);
	});

	it("does not consume queued steering after a late tool completion", async () => {
		const controller = new AbortController();
		const started = deferred<void>();
		const finish = deferred<RuntimeToolResult>();
		let polled = 0;
		const events: AgentExecutionEvent[] = [];
		const work = executeRuntimeToolCalls({
			calls: [call("a"), call("b")],
			tools: [tool(async (_input, context) => {
				started.resolve();
				const value = await finish.promise;
				context.onUpdate(result);
				context.reportPhase("late");
				return value;
			})],
			messages: [], modelCallIndex: 0, signal: controller.signal, emit: (event) => events.push(event),
			policy: { authorize: async () => {} },
			takeSteeringMessages: async () => { polled += 1; return []; },
		});
		const rejection = assert.rejects(work, /stop/);
		await started.promise;
		controller.abort(new Error("stop"));
		const before = events.length;
		finish.resolve(result);
		await rejection;
		assert.equal(events.length, before);
		assert.equal(polled, 0);
	});

	it("still executes successful multi-tool batches in order", async () => {
		const executed: string[] = [];
		const events: AgentExecutionEvent[] = [];
		const batch = await executeRuntimeToolCalls({
			calls: [call("a"), call("b")],
			tools: [tool(async (_input, context) => { executed.push(context.toolCallId); return result; })],
			messages: [], modelCallIndex: 0, signal: new AbortController().signal,
			emit: (event) => events.push(event), policy: { authorize: async () => {} },
		});
		assert.deepEqual(executed, ["a", "b"]);
		assert.equal(batch.results.length, 2);
		assert.equal(events.filter((event) => event.type === "tool_execution_finish").length, 2);
	});

	it("preserves denied-authorization errors without running the tool", async () => {
		let executed = 0;
		const batch = await executeRuntimeToolCalls({
			calls: [call("a")], tools: [tool(async () => { executed += 1; return result; })],
			messages: [], modelCallIndex: 0, signal: new AbortController().signal, emit: () => {},
			policy: { authorize: async () => { throw new Error("denied"); } },
		});
		assert.equal(executed, 0);
		assert.equal(batch.results[0].isError, true);
	});

	it("preserves steering skip results for remaining tools", async () => {
		const executed: string[] = [];
		const batch = await executeRuntimeToolCalls({
			calls: [call("a"), call("b")],
			tools: [tool(async (_input, context) => { executed.push(context.toolCallId); return result; })],
			messages: [], modelCallIndex: 0, signal: new AbortController().signal, emit: () => {},
			policy: { authorize: async () => {} },
			takeSteeringMessages: async () => [{ role: "user", content: "change", timestamp: 1 }],
		});
		assert.deepEqual(executed, ["a"]);
		assert.equal(batch.results.length, 2);
		assert.equal(batch.results[1].isError, true);
		assert.equal(batch.steeringMessages?.length, 1);
	});
});
