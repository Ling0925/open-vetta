import type { AssistantMessage, Model } from "@vetta/ai";
import { AssistantMessageEventStream } from "@vetta/ai";
import { describe, expect, it, vi } from "vitest";
import type {
	ConversationRepository,
	RuntimeSnapshot,
	RuntimeToolDefinition,
	StoredConversation,
} from "../../src/kernel/contracts.js";
import {
	AgentCoreTurnEngine,
	createAgentSession,
	KERNEL_ERROR_CODES,
	reconcileRuntimeInput,
	StaticRuntimeSnapshotProvider,
	TurnPipeline,
} from "../../src/kernel/index.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("Native Session cancellation fence", () => {
	it.each([false, true])("keeps admission closed until a queued-input append settles (fails: %s)", async (fails) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const modelStarted = deferred();
		const appendStarted = deferred();
		const finishAppend = deferred();
		const appendSettled = deferred();
		const stream = new AssistantMessageEventStream();
		const queuedMessage = { role: "user" as const, content: "follow up", timestamp: 2 };
		const repository = createRepository(async (events) => {
			if (!events.some((event) => event.type === "message.appended" && event.message === queuedMessage)) return;
			appendStarted.resolve();
			await finishAppend.promise;
			appendSettled.resolve();
			if (fails) throw new Error("Queued admission failed");
		});
		const pipeline = new TurnPipeline({
			repository,
			snapshotProvider: new StaticRuntimeSnapshotProvider({
				...snapshot(),
				inputRequestPreparer: {
					prepare: async () => ({ action: "continue", input: { message: queuedMessage } }),
				},
			}),
			turnEngine: new AgentCoreTurnEngine({
				model: MODEL,
				streamFn: () => {
					modelStarted.resolve();
					return stream;
				},
			}),
			eventSink: { publish: async () => {} },
			clock: { now: () => 1 },
			idGenerator: { next: () => "turn" },
		});
		const session = await createAgentSession({ id: "session", pipeline });
		const running = session.send({ message: { role: "user", content: "initial", timestamp: 1 } });
		try {
			await modelStarted.promise;
			await session.sendRequest(
				{ inputId: "queued-input", displayText: queuedMessage.content, payload: {} },
				{ streamingBehavior: "followUp" },
			);
			stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }], "stop") });
			await appendStarted.promise;
			const cancelling = session.cancel("stop during queued admission", { waitMs: 2_000 });
			await vi.advanceTimersByTimeAsync(2_000);
			await cancelling;

			expect(session.state).toBe("cancelling");
			await expect(
				session.send({ message: { role: "user", content: "too early", timestamp: 3 } }),
			).rejects.toMatchObject({ code: KERNEL_ERROR_CODES.SESSION_BUSY });
			expect(
				(await repository.load("session")).events.some(
					(event) =>
						event.type === "turn.cancelled" || event.type === "turn.completed" || event.type === "turn.failed",
				),
			).toBe(false);

			finishAppend.resolve();
			await expect(running).resolves.toMatchObject({ status: "cancelled" });
			expect(session.state).toBe("idle");
			expect(session.pendingMessageCount).toBe(fails ? 1 : 0);
			const conversation = await repository.load("session");
			expect(conversation.messages.filter((message) => message.role === "user")).toEqual([
				{ role: "user", content: "initial", timestamp: 1 },
				...(fails ? [] : [queuedMessage]),
			]);
			expect(reconcileRuntimeInput(conversation, "queued-input").status).toBe(fails ? "missing" : "cancelled");
			expect(session.listQueue().paused).toBe(true);
			expect(conversation.events.at(-1)).toMatchObject({ type: "turn.cancelled" });
		} finally {
			finishAppend.resolve();
			await appendSettled.promise;
			await running;
			await session.close();
			vi.useRealTimers();
		}
	});

	it("aborts its own execution and waits for effects when the event consumer returns early", async () => {
		const effectStarted = deferred();
		const effectAborted = deferred();
		const finishEffect = deferred();
		const parent = new AbortController();
		const tool: RuntimeToolDefinition = {
			name: "write_note",
			label: "Write note",
			description: "Write a note",
			inputSchema: { type: "object", properties: {} },
			async execute({ signal }) {
				signal.addEventListener("abort", effectAborted.resolve, { once: true });
				effectStarted.resolve();
				await finishEffect.promise;
				return { content: [{ type: "text", text: "saved" }] };
			},
		};
		const engine = new AgentCoreTurnEngine({
			model: MODEL,
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistant(
							[{ type: "toolCall", id: "write-1", name: "write_note", arguments: {} }],
							"toolUse",
						),
					}),
				);
				return stream;
			},
		});
		const iterator = engine
			.execute({
				sessionId: "session",
				turnId: "turn",
				snapshot: snapshot(tool),
				messages: [{ role: "user", content: "write", timestamp: 1 }],
				signal: parent.signal,
			})
			[Symbol.asyncIterator]();
		try {
			while (true) {
				const event = await iterator.next();
				if (event.done) throw new Error("Engine completed before the tool started");
				if (event.value.type === "execution_observation" && event.value.observation.type === "tool.execution.start")
					break;
			}
			await effectStarted.promise;
			let returned = false;
			const closing = iterator.return?.().then(() => {
				returned = true;
			});
			await effectAborted.promise;
			expect(parent.signal.aborted).toBe(false);
			expect(returned).toBe(false);
			finishEffect.resolve();
			await closing;
			expect(returned).toBe(true);
		} finally {
			finishEffect.resolve();
			await iterator.return?.();
		}
	});

	it("keeps admission closed after the stop wait expires until the started tool effect settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const effectStarted = deferred();
		const finishEffect = deferred();
		const effects: string[] = [];
		let modelCalls = 0;
		const tool: RuntimeToolDefinition = {
			name: "write_note",
			label: "Write note",
			description: "Write a note",
			inputSchema: { type: "object", properties: {} },
			async execute() {
				effectStarted.resolve();
				await finishEffect.promise;
				effects.push("saved");
				return { content: [{ type: "text", text: "saved" }] };
			},
		};
		const repository = createRepository();
		let turnIndex = 0;
		const pipeline = new TurnPipeline({
			repository,
			snapshotProvider: new StaticRuntimeSnapshotProvider(snapshot(tool)),
			turnEngine: new AgentCoreTurnEngine({
				model: MODEL,
				streamFn: () => {
					modelCalls += 1;
					const response =
						modelCalls === 1
							? assistant([{ type: "toolCall", id: "write-1", name: "write_note", arguments: {} }], "toolUse")
							: assistant([{ type: "text", text: "ready" }], "stop");
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push({
							type: "done",
							reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
							message: response,
						}),
					);
					return stream;
				},
			}),
			eventSink: { publish: async () => {} },
			clock: { now: () => 1 },
			idGenerator: { next: () => `turn-${++turnIndex}` },
		});
		const session = await createAgentSession({ id: "session", pipeline });
		const running = session.send({ message: { role: "user", content: "write", timestamp: 1 } });
		try {
			await effectStarted.promise;
			const cancelling = session.cancel("user stop", { waitMs: 2_000 });
			await vi.advanceTimersByTimeAsync(2_000);
			await cancelling;

			expect(session.state).toBe("cancelling");
			expect(effects).toEqual([]);
			await expect(
				session.send({ message: { role: "user", content: "too early", timestamp: 2 } }),
			).rejects.toMatchObject({ code: KERNEL_ERROR_CODES.SESSION_BUSY });
			expect(
				(await repository.load("session")).events.some(
					(event) =>
						event.type === "turn.cancelled" || event.type === "turn.completed" || event.type === "turn.failed",
				),
			).toBe(false);
			expect(modelCalls).toBe(1);

			finishEffect.resolve();
			await expect(running).resolves.toMatchObject({ status: "cancelled" });
			expect(effects).toEqual(["saved"]);
			expect(session.state).toBe("idle");
			expect((await repository.load("session")).events.at(-1)).toMatchObject({ type: "turn.cancelled" });
			await expect(
				session.send({ message: { role: "user", content: "next", timestamp: 3 } }),
			).resolves.toMatchObject({ status: "completed" });
			expect(modelCalls).toBe(2);
		} finally {
			finishEffect.resolve();
			await running;
			await session.close();
			vi.useRealTimers();
		}
	});
});

function createRepository(
	beforeAppend?: (events: Parameters<ConversationRepository["append"]>[2]) => Promise<void>,
): ConversationRepository {
	let conversation: StoredConversation = { sessionId: "session", createdAt: 1, version: 0, events: [], messages: [] };
	return {
		create: async () => conversation,
		load: async () => conversation,
		append: async (_sessionId, expectedVersion, events) => {
			await beforeAppend?.(events);
			if (conversation.version !== expectedVersion) throw new Error("Conversation version conflict");
			conversation = {
				...conversation,
				version: expectedVersion + events.length,
				events: [...conversation.events, ...events],
				messages: [
					...conversation.messages,
					...events.flatMap((event) => (event.type === "message.appended" ? [event.message] : [])),
				],
			};
			return { version: conversation.version };
		},
		saveSnapshot: async () => {},
		close: async () => {},
	};
}

function snapshot(tool?: RuntimeToolDefinition): RuntimeSnapshot {
	return {
		id: "snapshot",
		instructions: [],
		tools: new Map(tool ? [[tool.name, tool]] : []),
		contextProviders: [],
		contextStrategy: { prepare: async (input) => ({ messages: input.messages, estimatedTokens: 0 }) },
		toolPolicy: { authorize: async () => true },
		tokenBudget: 8_000,
		reservedOutputTokens: 1_000,
		observers: [],
	};
}

const MODEL: Model<"openai-responses"> = {
	id: "recorded-model",
	name: "Recorded Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
	maxTokens: 1_000,
};

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: MODEL.id,
		stopReason,
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
}
