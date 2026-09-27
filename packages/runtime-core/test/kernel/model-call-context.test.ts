import type { Message } from "@vetta/ai";
import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot, RuntimeTurnModelBinding } from "../../src/kernel/contracts.js";
import {
	finalizeRuntimeModelCallMessages,
	prepareRuntimeModelCallCheckpoint,
} from "../../src/kernel/model-call-context.js";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });

describe("Runtime model-call Context Plane", () => {
	it("orders transform before durable checkpoint and finalization after it", async () => {
		const order: string[] = [];
		const binding = { model: {} as never } satisfies RuntimeTurnModelBinding;
		const snapshot = {
			modelCallContextTransformer: {
				transform: async (input: { messages: readonly Message[] }) => {
					order.push("transform");
					return [user("transformed"), input.messages.at(-1)!];
				},
			},
			modelCallMessageFinalizer: {
				finalize: async (input: { messages: readonly Message[] }) => {
					order.push("finalize");
					return [...input.messages, user("finalized")];
				},
			},
		} as unknown as RuntimeSnapshot;
		const current = user("current");
		const checkpoint = await prepareRuntimeModelCallCheckpoint({
			sessionId: "session",
			turnId: "turn",
			snapshot,
			modelBinding: binding,
			messages: [user("old"), current],
			reason: "model_call",
			modelCallIndex: 0,
			recoveryAttempt: 0,
			signal: new AbortController().signal,
			checkpoint: async (request) => {
				order.push("checkpoint");
				expect(request.messages.map((message) => message.content)).toEqual(["transformed", "current"]);
				return { messages: [user("summary"), current] };
			},
		});
		const finalized = await finalizeRuntimeModelCallMessages({
			sessionId: "session",
			turnId: "turn",
			snapshot,
			modelBinding: binding,
			messages: checkpoint!.messages,
			signal: new AbortController().signal,
		});
		expect(order).toEqual(["transform", "checkpoint", "finalize"]);
		expect(finalized.map((message) => message.content)).toEqual(["summary", "current", "finalized"]);
	});

	it("still returns transformed model-call messages when no durable checkpoint is installed", async () => {
		const snapshot = {
			modelCallContextTransformer: {
				transform: async () => [user("projected")],
			},
		} as unknown as RuntimeSnapshot;
		await expect(
			prepareRuntimeModelCallCheckpoint({
				sessionId: "session",
				turnId: "turn",
				snapshot,
				modelBinding: { model: {} as never },
				messages: [user("old")],
				reason: "model_call",
				recoveryAttempt: 0,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ messages: [user("projected")] });
	});
});
