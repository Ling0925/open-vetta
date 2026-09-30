import assert from "node:assert/strict";
import {
	createAgentSession,
	PassthroughContextStrategy,
	RandomIdGenerator,
	type RuntimeSnapshot,
	type SessionInputRequest,
	StaticRuntimeSnapshotProvider,
	SystemClock,
	TurnPipeline,
} from "@vetta/runtime-core/kernel";
import { describe, it, vi } from "vitest";
import { CodexConversationTurnEngine } from "../../src/codex-app-server/conversation-turn-engine.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { CodexRpcConnection } from "../../src/codex-app-server/rpc.js";
import { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import type { JsonObject } from "../../src/codex-app-server/types.js";
import { InMemoryConversationRepository } from "../../src/conversation/in-memory-conversation-repository.js";
import { MemoryTransport } from "./helpers.js";

const prompt = (text: string): SessionInputRequest => ({
	payload: { text },
	displayText: text,
	inputId: `input-${text}`,
});

async function fixture() {
	const repository = new InMemoryConversationRepository();
	const starts = new Map<number, ReturnType<typeof deferred<void>>>();
	const connections: Array<{
		input: string;
		closed: boolean;
		finish(status?: "completed" | "interrupted" | "failed"): void;
	}> = [];
	const prepared: string[] = [];
	const modelContexts: string[] = [];
	const engine = new CodexConversationTurnEngine(async () => {
		assert.ok(
			connections.every((connection) => connection.closed),
			"Turns must not overlap owned processes",
		);
		const index = connections.length;
		const transport = new MemoryTransport();
		const rpc = new CodexRpcConnection(transport);
		await rpc.initialize();
		const thread = { id: `thread-${index}`, turns: [] as JsonObject[] };
		const remote = new CodexAppServerSession(rpc, thread);
		const connection = {
			input: "",
			closed: false,
			finish(status: "completed" | "interrupted" | "failed" = "completed") {
				const item = { id: `answer-${index}`, type: "agentMessage", text: `answer ${index}` };
				const turn = { id: `turn-${index}`, status, items: [item], itemsView: "full" };
				thread.turns = [turn];
				transport.notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
				transport.notify("turn/completed", { threadId: thread.id, turn });
			},
		};
		connections.push(connection);
		transport.onSend = (frame) => {
			if (frame.method === "turn/start") {
				const params = frame.params as { input: Array<{ text: string }> };
				connection.input = params.input[0].text;
				transport.reply(frame, { turn: { id: `turn-${index}`, status: "inProgress", items: [] } });
				starts.get(index)?.resolve();
			} else if (frame.method === "thread/read") {
				transport.reply(frame, { thread });
			} else if (frame.method === "turn/interrupt") {
				transport.reply(frame, {});
				connection.finish("interrupted");
			}
		};
		return {
			session: remote,
			close: async () => {
				await remote.close();
				connection.closed = true;
			},
		};
	});
	const snapshot: RuntimeSnapshot = {
		id: "codex-queue-integration",
		instructions: [],
		tools: new Map(),
		contextProviders: [],
		contextStrategy: new PassthroughContextStrategy(),
		toolPolicy: { authorize: async () => true },
		tokenBudget: 8000,
		reservedOutputTokens: 1000,
		observers: [],
		inputRequestPreparer: {
			prepare: async (request) => {
				prepared.push(request.displayText);
				return {
					action: "continue",
					input: { message: { role: "user", content: request.displayText, timestamp: 1 } },
				};
			},
		},
		modelCallMessageFinalizer: {
			finalize: async ({ messages }) => {
				modelContexts.push(JSON.stringify(messages));
				return messages;
			},
		},
	};
	const pipeline = new TurnPipeline({
		repository,
		conversationDocumentReader: repository,
		snapshotProvider: new StaticRuntimeSnapshotProvider(snapshot, {
			bind: () => ({
				model: {
					id: "fixture",
					name: "Fixture",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8000,
					maxTokens: 1000,
				},
			}),
		}),
		turnEngine: engine,
		eventSink: { publish: async () => {} },
		clock: new SystemClock(),
		idGenerator: new RandomIdGenerator(),
	});
	const session = await createAgentSession({ id: "conversation", pipeline });
	return {
		session,
		repository,
		connections,
		prepared,
		modelContexts,
		waitForStart: (index: number) => {
			if (connections[index]?.input) return Promise.resolve();
			const started = starts.get(index) ?? deferred<void>();
			starts.set(index, started);
			return started.promise;
		},
	};
}

describe("Codex follow-up admission through the original Session and Pipeline", () => {
	it("runs an accepted follow-up after Codex closes, with a fresh Vetta context and durable user input", async () => {
		const f = await fixture();
		try {
			const active = f.session.sendRequest(prompt("first"));
			await f.waitForStart(0);
			assert.equal(
				(await f.session.sendRequest(prompt("next"), { streamingBehavior: "followUp" })).status,
				"queued",
			);
			assert.deepEqual(f.prepared, ["first"]);
			f.connections[0].finish();
			assert.equal((await active).status, "completed");
			await f.waitForStart(1);
			assert.equal(
				f.session.pendingMessageCount,
				0,
				"Accepted follow-ups must not remain stranded after a successful turn",
			);
			assert.deepEqual(f.prepared, ["first", "next"]);
			assert.equal(f.modelContexts.length, 2);
			assert.match(f.connections[1].input, /answer 0/);
			assert.match(f.connections[1].input, /next/);
			f.connections[1].finish();
			await vi.waitFor(() => assert.equal(f.session.state, "idle"));
			const conversation = await f.repository.load("conversation");
			assert.deepEqual(
				conversation.messages.filter((message) => message.role === "user").map((message) => message.content),
				["first", "next"],
			);
			assert.equal(conversation.events.filter((event) => event.type === "turn.completed").length, 2);
		} finally {
			await f.session.close();
		}
	});

	it("keeps a queued follow-up paused when the active Codex turn is cancelled", async () => {
		const f = await fixture();
		try {
			const active = f.session.sendRequest(prompt("first"));
			await f.waitForStart(0);
			await f.session.sendRequest(prompt("next"), { streamingBehavior: "followUp" });
			await f.session.cancel();
			assert.equal((await active).status, "cancelled");
			assert.equal(f.connections.length, 1);
			assert.equal(f.connections[0].closed, true);
			assert.equal(f.session.pendingMessageCount, 1);
			assert.equal(f.session.listQueue().paused, true);
			assert.deepEqual(f.prepared, ["first"]);
		} finally {
			await f.session.close();
		}
	});

	it("keeps a queued follow-up paused when Codex reports a failed turn", async () => {
		const f = await fixture();
		try {
			const active = f.session.sendRequest(prompt("first"));
			await f.waitForStart(0);
			await f.session.sendRequest(prompt("next"), { streamingBehavior: "followUp" });
			f.connections[0].finish("failed");
			assert.equal((await active).status, "failed");
			assert.equal(f.connections.length, 1);
			assert.equal(f.connections[0].closed, true);
			assert.equal(f.session.pendingMessageCount, 1);
			assert.equal(f.session.listQueue().paused, true);
			assert.deepEqual(f.prepared, ["first"]);
		} finally {
			await f.session.close();
		}
	});
});
