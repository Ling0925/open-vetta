import { setImmediate } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { type AssistantMessage, LanguageModelStream } from "@vetta/ai";
import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../src/engine/run-agent-turn.js";
import type { AgentExecutionEvent, AgentTurnRequest, RuntimeToolDefinition } from "../src/engine/types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

const result = { content: [{ type: "text" as const, text: "written" }], details: {} };

function request(tool: RuntimeToolDefinition, signal: AbortSignal): AgentTurnRequest {
	return {
		messages: [{ role: "user", content: "write", timestamp: 1 }],
		resolveTools: async () => [tool],
		resolveModelCall: async () => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "first", name: "write", arguments: {} },
					{ type: "toolCall", id: "second", name: "write", arguments: {} },
				],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = new LanguageModelStream();
			stream.push({ type: "done", reason: "toolUse", message });
			return { callId: "model-call", snapshotId: "snapshot", response: { events: stream, result: stream.result() } };
		},
		toolPolicy: { authorize: async () => {} },
		limits: { maxModelCalls: 2, maxToolCalls: 4, maxRecoveryAttempts: 0, checkpointTimeoutMs: 1000 },
		signal,
	};
}

function tool(execute: RuntimeToolDefinition["execute"]): RuntimeToolDefinition {
	return { name: "write", description: "Write fixture", inputSchema: Type.Object({}), execute };
}

describe("Native tool effect ownership during cancellation", () => {
	it.each(["approve", "deny"] as const)(
		"settles pending authorization cancellation before a late %s",
		async (decision) => {
			const controller = new AbortController();
			const waiting = deferred<void>();
			const approval = deferred<void>();
			let executions = 0;
			const events: AgentExecutionEvent[] = [];
			const run = runAgentTurn({
				...request(
					tool(async () => {
						executions += 1;
						return result;
					}),
					controller.signal,
				),
				toolPolicy: {
					authorize: async () => {
						waiting.resolve();
						await approval.promise;
					},
				},
				observer: (event) => events.push(event),
			});
			await waiting.promise;
			controller.abort("stop awaiting approval");
			try {
				await expect(run.result).resolves.toMatchObject({ status: "aborted" });
			} finally {
				if (decision === "approve") approval.resolve();
				else approval.reject(new Error("late denial"));
			}
			await setImmediate();
			expect(executions).toBe(0);
			expect(events.filter((event) => event.type === "run_finish")).toHaveLength(1);
		},
	);

	it.each(["complete", "fail"] as const)(
		"waits for an already-started effect to %s before terminating",
		async (outcome) => {
			const controller = new AbortController();
			const started = deferred<void>();
			const finish = deferred<void>();
			const order: string[] = [];
			const events: AgentExecutionEvent[] = [];
			let executions = 0;
			let settled = false;
			const run = runAgentTurn({
				...request(
					tool(async () => {
						executions += 1;
						started.resolve();
						try {
							await finish.promise;
							return result;
						} finally {
							order.push("effect settled");
						}
					}),
					controller.signal,
				),
				observer: (event) => {
					events.push(event);
					if (event.type === "run_finish") order.push("run finished");
				},
			});
			void run.result.then(() => {
				settled = true;
			});
			await started.promise;
			controller.abort("stop active effect");
			try {
				await setImmediate();
				expect(settled, "The Turn must still own an effect that has not settled").toBe(false);
				expect(events.some((event) => event.type === "run_finish")).toBe(false);
			} finally {
				if (outcome === "fail") finish.reject(new Error("effect stopped"));
				else finish.resolve();
				await run.result;
			}
			expect(await run.result).toMatchObject({ status: "aborted" });
			expect(order).toEqual(["effect settled", "run finished"]);
			expect(executions).toBe(1);
			expect(events.filter((event) => event.type === "run_finish")).toHaveLength(1);
		},
	);
});
