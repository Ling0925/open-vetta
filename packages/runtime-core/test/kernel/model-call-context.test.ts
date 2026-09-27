import type { Message } from "@vetta/ai";
import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot, RuntimeTurnModelBinding } from "../../src/kernel/contracts.js";
import {
	createRuntimeTurnContextPlane,
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

	it("gives execution loops one Vetta-owned prepareModelCall port with dynamic session identity", async () => {
		const calls: string[] = [];
		let sessionId = "session-a";
		const binding = { model: {} as never } satisfies RuntimeTurnModelBinding;
		const snapshot = {
			modelCallContextTransformer: {
				transform: async (input: { sessionId: string; messages: readonly Message[] }) => {
					calls.push(`transform:${input.sessionId}`);
					return [user("transformed"), ...input.messages.slice(-1)];
				},
			},
			modelCallMessageFinalizer: {
				finalize: async (input: { sessionId: string; messages: readonly Message[] }) => {
					calls.push(`finalize:${input.sessionId}`);
					return [...input.messages, user("final")];
				},
			},
		} as unknown as RuntimeSnapshot;
		const plane = createRuntimeTurnContextPlane({
			getSessionId: () => sessionId,
			turnId: "turn",
			snapshot,
			modelBinding: binding,
			checkpoint: async (request) => {
				calls.push(`checkpoint:${sessionId}`);
				return { messages: [user("summary"), request.messages.at(-1)!] };
			},
		});
		sessionId = "session-b";
		const result = await plane.prepareModelCall(
			{
				reason: "model_call",
				messages: [user("old"), user("current")],
				modelCallIndex: 0,
				recoveryAttempt: 0,
			},
			new AbortController().signal,
		);
		expect(calls).toEqual(["transform:session-b", "checkpoint:session-b", "finalize:session-b"]);
		expect(result?.messages.map((message) => message.content)).toEqual(["summary", "current", "final"]);
	});

	it("does not run the finalizer for assistant recovery checkpoints", async () => {
		let finalized = 0;
		const snapshot = {
			modelCallMessageFinalizer: {
				finalize: async (input: { messages: readonly Message[] }) => {
					finalized += 1;
					return input.messages;
				},
			},
		} as unknown as RuntimeSnapshot;
		const plane = createRuntimeTurnContextPlane({
			getSessionId: () => "session",
			turnId: "turn",
			snapshot,
			modelBinding: { model: {} as never },
			checkpoint: async (request) => ({ messages: request.messages, retry: true }),
		});
		const result = await plane.prepareModelCall(
			{ reason: "assistant_error", messages: [user("current")], recoveryAttempt: 1 },
			new AbortController().signal,
		);
		expect(result?.retry).toBe(true);
		expect(finalized).toBe(0);
	});
});
