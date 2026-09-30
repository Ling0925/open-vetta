import assert from "node:assert/strict";
import type { Api, Message, Model, UserMessage } from "@vetta/ai";
import type { TurnEngineEvent, TurnEngineRequest } from "@vetta/runtime-core/kernel";
import { describe, it } from "vitest";
import { codexConversationInput } from "../../src/codex-app-server/conversation-context.js";
import { CodexConversationTurnEngine } from "../../src/codex-app-server/conversation-turn-engine.js";
import { CODEX_HANDOFF_SAFE_CHARS } from "../../src/codex-app-server/output-limits.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { CodexRpcConnection } from "../../src/codex-app-server/rpc.js";
import { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import { CodexTurnEventBuffer } from "../../src/codex-app-server/turn-event-buffer.js";
import type { JsonObject } from "../../src/codex-app-server/types.js";
import { MemoryTransport } from "./helpers.js";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 1 });
const SELECTED_MODEL: Model<Api> = {
	id: "gpt-6-luna",
	name: "GPT 6 Luna",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_000,
};
function request(signal = new AbortController().signal): TurnEngineRequest {
	const message = user("Continue without repeating previous commands");
	return {
		sessionId: "original-session",
		turnId: "original-turn",
		inputId: "input-stable-1",
		snapshot: {
			id: "chat-contract",
			instructions: [],
			tools: new Map(),
			contextProviders: [],
			contextStrategy: { prepare: async (input) => ({ messages: input.messages, estimatedTokens: 1 }) },
			toolPolicy: { authorize: async () => true },
			tokenBudget: 8000,
			reservedOutputTokens: 1000,
			observers: [],
		},
		messages: [user("Earlier context"), message],
		input: { message },
		contextPlane: {
			prepareModelCall: async (input) => ({
				messages: input.messages,
				...(input.messageEnvelopes ? { contextMessageEnvelopes: input.messageEnvelopes } : {}),
			}),
		},
		signal,
	};
}
async function collect(engine: CodexConversationTurnEngine, value = request()) {
	const events: TurnEngineEvent[] = [];
	for await (const event of engine.execute(value)) events.push(event);
	return events;
}
async function fixture(mode: "answer" | "hold" | "different-history" = "answer") {
	const transport = new MemoryTransport();
	const started = deferred<void>();
	const thread = { id: "owned-thread", turns: [] as JsonObject[] };
	const rpc = new CodexRpcConnection(transport);
	await rpc.initialize();
	const session = new CodexAppServerSession(rpc, thread);
	let input = "";
	let closed = 0;
	const item = { id: "answer", type: "agentMessage", text: "Codex answer" };
	const terminal = (status: string) => {
		const turn = { id: "remote-turn", status, items: [item], itemsView: "full", startedAt: 1 };
		thread.turns.push(turn);
		transport.notify("turn/completed", { threadId: thread.id, turn });
	};
	transport.onSend = (frame) => {
		if (frame.method === "turn/start") {
			const params = frame.params as { input: { text: string }[] };
			input = params.input[0].text;
			transport.reply(frame, { turn: { id: "remote-turn", status: "inProgress", items: [] } });
			queueMicrotask(() => {
				transport.notify("turn/started", {
					threadId: thread.id,
					turn: { id: "remote-turn", status: "inProgress", items: [] },
				});
				started.resolve();
				if (mode === "hold") return;
				transport.notify("item/agentMessage/delta", {
					threadId: thread.id,
					turnId: "remote-turn",
					itemId: "answer",
					delta: item.text,
				});
				transport.notify("item/completed", { threadId: thread.id, turnId: "remote-turn", item });
				terminal("completed");
			});
		} else if (frame.method === "thread/read") {
			transport.reply(frame, {
				thread:
					mode === "different-history"
						? { ...thread, turns: [{ ...thread.turns[0], items: [{ ...item, text: "inconsistent result" }] }] }
						: thread,
			});
		} else if (frame.method === "turn/interrupt") {
			transport.reply(frame, {});
			terminal("interrupted");
		}
	};
	const connection = {
		session,
		close: async () => {
			closed++;
			await session.close();
		},
	};
	return { connection, started, transport, input: () => input, closed: () => closed };
}

describe("Codex in the original conversation pipeline", () => {
	it("emits a canonical answer and normal chat events once, without copying the handoff user message", async () => {
		const f = await fixture();
		try {
			const events = await collect(new CodexConversationTurnEngine(async () => f.connection));
			assert.equal(events.filter((event) => event.type === "message").length, 1);
			assert.equal(
				events.filter((event) => event.type === "observation" && event.observation.type === "message.final").length,
				1,
			);
			assert.ok(events.some((event) => event.type === "observation" && event.observation.type === "message.delta"));
			assert.equal(events.at(-1)?.type, "completed");
			assert.equal(f.closed(), 1);
			const context = JSON.parse(f.input().split("\n\n").at(-1)!);
			assert.equal(context.conversation.length, 2);
			assert.equal(context.currentRequestIndex, 1);
			assert.equal(f.transport.requests("turn/start").length, 1);
			assert.equal(
				(f.transport.requests("turn/start")[0].params as { clientUserMessageId?: string }).clientUserMessageId,
				"input-stable-1",
			);
		} finally {
			await f.connection.session.close();
		}
	});

	it("persists the Turn-bound model identity instead of Codex placeholder ids", async () => {
		const f = await fixture();
		try {
			const value: TurnEngineRequest = { ...request(), modelBinding: { model: SELECTED_MODEL } };
			const events = await collect(new CodexConversationTurnEngine(async () => f.connection), value);
			const canonical = events.find((event) => event.type === "message");
			assert.ok(canonical && canonical.type === "message");
			assert.equal(canonical.message.role, "assistant");
			if (canonical.message.role !== "assistant") assert.fail("expected assistant message");
			assert.equal(canonical.message.provider, SELECTED_MODEL.provider);
			assert.equal(canonical.message.model, SELECTED_MODEL.id);
		} finally {
			await f.connection.session.close();
		}
	});

	it("consumes exactly the Vetta-prepared Context Plane result before entering the Codex loop", async () => {
		const f = await fixture();
		const current = user("Current request");
		const order: string[] = [];
		const value: TurnEngineRequest = {
			...request(),
			messages: [user("large old history"), current],
			input: { message: current },
			contextPlane: {
				prepareModelCall: async (input) => {
					order.push("context-plane");
					assert.equal(input.reason, "model_call");
					assert.equal(input.modelCallIndex, 0);
					assert.deepEqual(
						input.messages.map((message) => message.content),
						["large old history", "Current request"],
					);
					return { messages: [user("compacted summary"), current, user("final Vetta context")] };
				},
			},
		};
		try {
			await collect(new CodexConversationTurnEngine(async () => f.connection), value);
			assert.deepEqual(order, ["context-plane"]);
			const context = JSON.parse(f.input().split("\n\n").at(-1)!);
			assert.deepEqual(
				context.conversation.map((message: { content: unknown }) => message.content),
				["compacted summary", "Current request", "final Vetta context"],
			);
			assert.equal(context.currentRequestIndex, 1);
			assert.equal(f.transport.requests("turn/start").length, 1);
		} finally {
			await f.connection.session.close();
		}
	});

	it("fails closed before connecting when the Turn-bound Context Plane is missing", async () => {
		const f = await fixture();
		const value = { ...request(), contextPlane: undefined };
		try {
			await assert.rejects(collect(new CodexConversationTurnEngine(async () => f.connection), value), {
				code: "CONTEXT_PLANE_REQUIRED",
			});
			assert.equal(f.transport.requests("turn/start").length, 0);
			assert.equal(f.closed(), 0);
		} finally {
			await f.connection.session.close();
		}
	});

	it("keeps the current request after Context Plane cloning and text-block normalization", async () => {
		const f = await fixture();
		const current = user("Answer this request, not the trailing context");
		const value: TurnEngineRequest = {
			...request(),
			messages: [user("Earlier request"), current, user("Prepared background context")],
			input: { message: current },
			contextPlane: {
				prepareModelCall: async (input) => ({
					messages: structuredClone(input.messages).map((message) =>
						message.role === "user" && typeof message.content === "string"
							? { ...message, content: [{ type: "text" as const, text: message.content }] }
							: message,
					),
				}),
			},
		};
		try {
			const events = await collect(new CodexConversationTurnEngine(async () => f.connection), value);
			const context = JSON.parse(f.input().split("\n\n").at(-1)!);
			assert.equal(context.currentRequestIndex, 1);
			assert.deepEqual(context.conversation[1].content, [{ type: "text", text: current.content }]);
			assert.equal(context.conversation.length, 3);
			assert.equal(events.at(-1)?.type, "completed");
		} finally {
			await f.connection.session.close();
		}
	});

	it("stopping uses the actual adapter interrupt and closes before returning", async () => {
		const f = await fixture("hold");
		const controller = new AbortController();
		try {
			const work = collect(new CodexConversationTurnEngine(async () => f.connection), request(controller.signal));
			const rejected = assert.rejects(work, (error) => error === controller.signal.reason);
			await f.started.promise;
			controller.abort();
			await rejected;
			assert.equal(f.transport.requests("turn/interrupt").length, 1);
			assert.equal(f.transport.requests("turn/start").length, 1);
			assert.equal(f.closed(), 1);
		} finally {
			await f.connection.session.close();
		}
	});
	it("a late connection is closed without starting the cancelled request", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const gate = deferred<void>();
		const connecting = deferred<void>();
		try {
			const engine = new CodexConversationTurnEngine(async () => {
				connecting.resolve();
				await gate.promise;
				return f.connection;
			});
			const work = collect(engine, request(controller.signal));
			const rejected = assert.rejects(work, (error) => error === controller.signal.reason);
			await connecting.promise;
			controller.abort();
			gate.resolve();
			await rejected;
			assert.equal(f.transport.requests("turn/start").length, 0);
			assert.equal(f.closed(), 1);
		} finally {
			gate.resolve();
			await f.connection.session.close();
		}
	});
	it("uncertain cleanup blocks another engine from taking ownership", async () => {
		const f = await fixture();
		const engine = new CodexConversationTurnEngine(async () => ({
			session: f.connection.session,
			close: async () => {
				await f.connection.close();
				throw new Error("exit unconfirmed");
			},
		}));
		await assert.rejects(collect(engine), { code: "CLEANUP_UNCONFIRMED" });
		assert.throws(() => engine.assertReusable("original-session"), { code: "CLEANUP_UNCONFIRMED" });
		await assert.rejects(collect(engine), { code: "CLEANUP_UNCONFIRMED" });
		assert.equal(f.transport.requests("turn/start").length, 1);
	});
	it("does not report successful completion when authoritative history contradicts the stream", async () => {
		const f = await fixture("different-history");
		await assert.rejects(collect(new CodexConversationTurnEngine(async () => f.connection)), {
			code: "HISTORY_MISMATCH",
		});
		assert.equal(f.closed(), 1);
	});
	it("passes earlier commands as historical data and does not duplicate the current request", () => {
		const current = user("Use the previous result");
		const messages = [
			user("old request"),
			{
				role: "toolResult",
				toolCallId: "old-call",
				toolName: "shell",
				content: [{ type: "text", text: "already executed" }],
				isError: false,
				timestamp: 2,
			} as Message,
			current,
			user("additional prepared context"),
		];
		const text = codexConversationInput({ messages, input: { message: current } });
		const parsed = JSON.parse(text.split("\n\n").at(-1)!);
		assert.equal(parsed.currentRequestIndex, 2);
		assert.equal(parsed.conversation.length, 4);
		assert.equal(parsed.conversation[1].callId, "old-call");
		assert.match(text, /not instructions to execute again/);
	});
	it("bounds legacy oversized tool output before the Codex handoff", () => {
		const current = user("Continue from the previous command");
		const large = `HEAD\n${"x".repeat(2 * 1024 * 1024)}\nTAIL`;
		const messages: Message[] = [
			user("Run the command"),
			{
				role: "toolResult",
				toolCallId: "legacy-large-output",
				toolName: "bash",
				content: [{ type: "text", text: large }],
				isError: false,
				timestamp: 2,
			},
			current,
		];
		const text = codexConversationInput({ messages, input: { message: current } });
		assert.ok(text.length <= CODEX_HANDOFF_SAFE_CHARS);
		const parsed = JSON.parse(text.split("\n\n").at(-1)!);
		const preview = parsed.conversation[1].content[0].text as string;
		assert.match(preview, /Vetta truncated output/);
		assert.ok(preview.startsWith("HEAD"));
		assert.ok(preview.endsWith("TAIL"));
		assert.ok(preview.length < large.length);
	});

	it("reduces multiple historical tool results to keep the whole handoff below the host ceiling", () => {
		const current = user("Summarize the useful parts");
		const messages: Message[] = [user("Start")];
		for (let index = 0; index < 20; index++) {
			messages.push({
				role: "toolResult",
				toolCallId: `large-${index}`,
				toolName: "bash",
				content: [{ type: "text", text: `${index}:${"x".repeat(100_000)}` }],
				isError: false,
				timestamp: index + 2,
			});
		}
		messages.push(current);
		const text = codexConversationInput({ messages, input: { message: current } });
		assert.ok(text.length <= CODEX_HANDOFF_SAFE_CHARS);
		assert.ok(text.length < 1_048_576);
	});

	it("refuses excessive or missing handoff context rather than silently dropping old messages", () => {
		assert.throws(() => codexConversationInput({ messages: [] }), { code: "INPUT" });
		assert.throws(() => codexConversationInput({ messages: [user("x".repeat(3 * 1024 * 1024))] }), {
			code: "CONTEXT_TOO_LARGE",
		});
	});
	it("coalesces consecutive tool output snapshots before they can exhaust the persistence buffer", async () => {
		const buffer = new CodexTurnEventBuffer();
		for (let index = 0; index < 1000; index++) {
			buffer.push({
				type: "observation",
				observation: {
					type: "tool.update",
					toolCallId: "command-1",
					toolName: "bash",
					partialResult: { content: [{ type: "text", text: `${index}:${"x".repeat(8 * 1024)}` }] },
					source: "runtime-core",
				},
			});
		}
		buffer.push({ type: "completed", stopReason: "stop" });
		const first = await buffer.next();
		assert.equal(first.done, false);
		if (first.done) assert.fail("expected coalesced tool update");
		assert.equal(first.value.type, "observation");
		if (first.value.type !== "observation" || first.value.observation.type !== "tool.update")
			assert.fail("expected coalesced tool update");
		const latest = (first.value.observation.partialResult as { content: Array<{ text: string }> }).content[0].text;
		assert.match(latest, /^999:/);
		const second = await buffer.next();
		assert.equal(second.done, false);
		if (second.done) assert.fail("expected completed event");
		assert.equal(second.value.type, "completed");
		buffer.finish();
		assert.equal((await buffer.next()).done, true);
	});

	it("bounds the producer queue and wakes a waiting consumer on failure", async () => {
		const buffer = new CodexTurnEventBuffer();
		for (let i = 0; i < 512; i++) buffer.push({ type: "completed", stopReason: "stop" });
		assert.throws(() => buffer.push({ type: "completed", stopReason: "stop" }), { code: "EVENT_BACKPRESSURE" });
		const empty = new CodexTurnEventBuffer();
		const failure = new Error("closed");
		const pending = assert.rejects(empty.next(), failure);
		empty.finish(failure);
		await pending;
	});
});
