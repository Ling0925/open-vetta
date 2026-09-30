import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Api, Model } from "@vetta/ai";
import {
	ComposedRuntimeFactory,
	KernelRuntimeSessionBackend,
	RuntimeModel,
	type RuntimePromptAdapter,
	type RuntimeSession,
	type SessionEvent,
} from "@vetta/runtime-core";
import {
	PassthroughContextStrategy,
	type RuntimeSnapshot,
	type RuntimeToolDefinition,
	StaticRuntimeSnapshotProvider,
} from "@vetta/runtime-core/kernel";
import { createWriteTool } from "@vetta/runtime-node/coding";
import { FileConversationRepository } from "@vetta/runtime-node/conversation";
import { describe, it } from "vitest";
import { CodingAgentTodoRuntime } from "../src/features/todo/todo-runtime.js";
import { createCodingAgentTodoRuntimeToolRegistration } from "../src/features/todo/todo-tool-feature.js";
import {
	deferred,
	RESPONSES_FIXTURE_KEY,
	RESPONSES_FIXTURE_MODEL,
	type ResponsesStep,
	startScriptedResponsesServer,
} from "./fixtures/scripted-responses-server.js";

const CONTEXT_MARKER = "Vetta model-call-only context";

async function fixture(steps: readonly ResponsesStep[]) {
	const root = await mkdtemp(join(tmpdir(), "vetta-native-product-"));
	const provider = await startScriptedResponsesServer(steps);
	const repositories: FileConversationRepository[] = [];
	const sessions: RuntimeSession[] = [];
	const todoRuntimes: CodingAgentTodoRuntime[] = [];
	const events: SessionEvent[] = [];
	const contextOrder: string[] = [];
	const approvalRequested = deferred<AbortSignal>();
	const decision = deferred<boolean>();
	const model: Model<Api> = {
		id: RESPONSES_FIXTURE_MODEL,
		name: "Offline native fixture",
		api: "openai-responses",
		provider: "openai",
		baseUrl: provider.baseUrl,
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 4000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const factory = new ComposedRuntimeFactory<Record<string, never>>({
		// No streamFn or execution composer override: exercise the production default engine and provider.
		createResources: async () => {
			const repository = new FileConversationRepository({ rootDir: join(root, "history") });
			repositories.push(repository);
			const todo = new CodingAgentTodoRuntime();
			todoRuntimes.push(todo);
			const modelRuntime = new RuntimeModel({
				initialModel: model,
				initialThinkingLevel: "off",
				catalog: { refresh: () => {}, listAvailable: () => [model], find: () => model },
				credentials: { resolve: async () => RESPONSES_FIXTURE_KEY, refreshAuth: async () => {} },
			});
			const promptAdapter: RuntimePromptAdapter = {
				createRequest: (request) => ({ payload: request, displayText: request.text, inputId: request.inputId }),
				prepare: async (request) => ({
					action: "continue",
					input: { message: { role: "user", content: request.displayText, timestamp: Date.now() } },
				}),
			};
			const tools: RuntimeToolDefinition[] = [
				createCodingAgentTodoRuntimeToolRegistration(todo).tool,
				createWriteTool(root, {
					pathPolicy: {
						getRejectionReason: (path) =>
							relative(root, path).startsWith("..") ? "Outside fixture workspace" : undefined,
					},
				}),
			];
			const passthrough = new PassthroughContextStrategy();
			const snapshot: RuntimeSnapshot = {
				id: "native-product",
				instructions: [],
				tools: new Map(tools.map((tool) => [tool.name, tool])),
				contextProviders: [],
				observers: [],
				tokenBudget: 28000,
				reservedOutputTokens: 4000,
				inputRequestPreparer: promptAdapter,
				contextStrategy: {
					prepare: async (input, signal) => {
						contextOrder.push(`checkpoint:${input.reason}`);
						return passthrough.prepare(input, signal);
					},
				},
				modelCallContextTransformer: {
					transform: async ({ messages }) => {
						contextOrder.push("transform");
						return messages;
					},
				},
				modelCallMessageFinalizer: {
					finalize: async ({ messages, modelBinding }) => {
						assert.equal(modelBinding.model.id, RESPONSES_FIXTURE_MODEL);
						assert.equal(contextOrder.at(-1), "checkpoint:model_call");
						contextOrder.push("finalize");
						return [...messages, { role: "user", content: CONTEXT_MARKER, timestamp: 1 }];
					},
				},
				toolPolicy: {
					authorize: async (request, signal) => {
						if (request.toolName !== "write") return true;
						approvalRequested.resolve(signal);
						return decision.promise;
					},
				},
			};
			return {
				sessionId: "native-product-session",
				repository,
				conversationDocumentStore: repository,
				promptAdapter,
				snapshotProvider: new StaticRuntimeSnapshotProvider(snapshot, modelRuntime),
				modelRuntime,
				identity: { cwd: root, sessionPath: repository.resolveConversationPath("native-product-session") },
				stateSource: {
					read: () => ({ contextPercent: 0, contextWindow: model.contextWindow, activeToolNames: [] }),
				},
				documentParticipants: [todo],
			};
		},
	});
	const backend = new KernelRuntimeSessionBackend({ runtimeFactory: factory });
	const open = async (resume = false) => {
		const session = resume ? await backend.resume({}) : await backend.create({});
		sessions.push(session);
		session.subscribe((event) => events.push(event));
		return session;
	};
	return {
		root,
		provider,
		repositories,
		todoRuntimes,
		events,
		contextOrder,
		approvalRequested,
		decision,
		open,
		close: async () => {
			decision.resolve(false);
			const cleanup = await Promise.allSettled(sessions.map((session) => session.dispose()));
			cleanup.push(...(await Promise.allSettled(repositories.map((repository) => repository.close()))));
			cleanup.push(...(await Promise.allSettled([provider.close(), rm(root, { recursive: true, force: true })])));
			assert.equal(cleanup.filter((result) => result.status === "rejected").length, 0, "Fixture cleanup failed");
		},
	};
}

describe("Native product workflow through the real Responses provider", () => {
	it("plans, approves a real file edit, streams a reply, cancels and reopens one canonical conversation", async () => {
		const f = await fixture([
			{
				type: "tool",
				name: "todo",
				arguments: {
					description: "Plan the change",
					action: "replace",
					plan: [{ content: "Write the result", status: "in_progress" }],
				},
			},
			{ type: "tool", name: "write", arguments: { path: "result.txt", content: "native product result" } },
			{
				type: "tool",
				name: "todo",
				arguments: {
					description: "Finish the plan",
					action: "replace",
					plan: [{ content: "Write the result", status: "done" }],
				},
			},
			{ type: "text", text: "The planned file is ready." },
			{ type: "hold" },
			{ type: "text", text: "The same conversation resumed." },
		]);
		try {
			const session = await f.open();
			const active = session.prompt({ text: "Plan and write the result", inputId: "first-prompt" });
			const approvalSignal = await f.approvalRequested.promise;
			assert.equal(approvalSignal.aborted, false);
			await assert.rejects(readFile(join(f.root, "result.txt")), { code: "ENOENT" });
			assert.deepEqual(
				f.todoRuntimes[0].getAll().map(({ content, status }) => ({ content, status })),
				[{ content: "Write the result", status: "in_progress" }],
			);
			f.decision.resolve(true);
			assert.equal((await active).status, "completed");
			assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "native product result");
			assert.deepEqual(f.todoRuntimes[0].getAll(), [{ id: 1, content: "Write the result", status: "done" }]);
			const document = await f.repositories[0].readDocument("native-product-session");
			assert.deepEqual(
				document.entries
					.filter((entry) => entry.type === "custom" && entry.customType === "todo_snapshot")
					.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
				[
					{ items: [{ id: 1, content: "Write the result", status: "in_progress" }], lockedBy: null },
					{ items: [{ id: 1, content: "Write the result", status: "done" }], lockedBy: null },
				],
				"Each atomic plan replacement must persist exactly one snapshot with stable item identity",
			);
			assert.equal(
				f.events
					.filter((event) => event.channel === "assistant" && event.type === "text_delta")
					.map((event) => (event.type === "text_delta" ? event.delta : ""))
					.join(""),
				"The planned file is ready.",
			);
			assert.ok(f.events.some((event) => event.type === "tool.end" && event.toolName === "write" && !event.isError));
			const messages = session.readMessages();
			assert.equal(messages.filter((message) => message.role === "user").length, 1);
			assert.equal(messages.filter((message) => message.role === "toolResult").length, 3);
			const written = messages.find((message) => message.role === "toolResult" && message.toolName === "write");
			assert.ok(written?.role === "toolResult");
			assert.ok(written.details && typeof written.details === "object" && "diff" in written.details);
			assert.equal(written.details.diff, "+1 native product result");
			assert.ok(
				messages
					.filter((message) => message.role === "assistant")
					.every(
						(message) =>
							message.model === RESPONSES_FIXTURE_MODEL &&
							message.api === "openai-responses" &&
							message.usage.totalTokens === 18,
					),
			);
			assert.ok(!JSON.stringify(messages).includes(CONTEXT_MARKER));
			assert.ok(f.provider.requests.every((request) => JSON.stringify(request.input).includes(CONTEXT_MARKER)));

			const waiting = session.prompt({ text: "Wait until I stop", inputId: "cancelled-prompt" });
			await f.provider.waitForRequest(4);
			await session.abort("user stop");
			assert.equal((await waiting).status, "cancelled");
			await f.provider.waitForDisconnect(4);
			assert.equal(session.readState().isStreaming, false);
			const before = session.readMessages();
			await session.dispose();
			const restored = await f.open(true);
			assert.deepEqual(restored.readMessages(), before);
			assert.deepEqual(f.todoRuntimes[1].getAll(), [{ id: 1, content: "Write the result", status: "done" }]);
			assert.equal(
				(await restored.prompt({ text: "Continue the same work", inputId: "resumed-prompt" })).status,
				"completed",
			);
			const stored = await f.repositories[1].load("native-product-session");
			assert.deepEqual(stored.messages, restored.readMessages());
			assert.equal(stored.events.filter((event) => event.type === "turn.completed").length, 2);
			assert.equal(stored.events.filter((event) => event.type === "turn.cancelled").length, 1);
			assert.equal(f.contextOrder.filter((phase) => phase === "finalize").length, 6);
			assert.ok(f.contextOrder.includes("checkpoint:assistant_result"));
			assert.deepEqual(f.provider.failures, []);
		} finally {
			await f.close();
		}
	});

	it("does not execute a write when approval arrives after cancellation", async () => {
		const f = await fixture([
			{ type: "tool", name: "write", arguments: { path: "must-not-exist.txt", content: "late approval" } },
		]);
		try {
			const session = await f.open();
			const active = session.prompt({ text: "Request a file change", inputId: "approval-cancel" });
			const approvalSignal = await f.approvalRequested.promise;
			const stopping = session.abort("cancel pending approval");
			assert.equal(approvalSignal.aborted, true);
			f.decision.resolve(true);
			await stopping;
			assert.equal((await active).status, "cancelled");
			await assert.rejects(readFile(join(f.root, "must-not-exist.txt")), { code: "ENOENT" });
			assert.equal(f.provider.requests.length, 1);
			assert.equal(session.readState().isStreaming, false);
			assert.deepEqual(f.provider.failures, []);
		} finally {
			await f.close();
		}
	});
});
