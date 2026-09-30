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
	type ToolPolicy,
} from "@vetta/runtime-core/kernel";
import { createNodeHostSessionCommandEnvironment, createWriteTool } from "@vetta/runtime-node/coding";
import { FileConversationRepository } from "@vetta/runtime-node/conversation";
import type { BackgroundCommandService } from "@vetta/runtime-tools";
import { describe, it } from "vitest";
import { createCodingToolsRuntimeComposition } from "../src/composition/tool-surface/runtime-tools-composition.js";
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

interface FixtureOptions {
	readonly commandTools?: boolean;
	readonly authorize?: ToolPolicy["authorize"];
}

async function fixture(
	steps: readonly ResponsesStep[] | ((root: string) => readonly ResponsesStep[]),
	options: FixtureOptions = {},
) {
	const root = await mkdtemp(join(tmpdir(), "vetta-native-product-"));
	const provider = await startScriptedResponsesServer(typeof steps === "function" ? steps(root) : steps);
	const repositories: FileConversationRepository[] = [];
	const sessions: RuntimeSession[] = [];
	const todoRuntimes: CodingAgentTodoRuntime[] = [];
	const backgroundServices: BackgroundCommandService[] = [];
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
			const commandEnvironment = options.commandTools
				? createNodeHostSessionCommandEnvironment({
						cwd: root,
						// A real Node child is sufficient to exercise pipe IO without relying on a user's shell setup.
						resolveShell: () => ({ executable: process.execPath, args: ["-e"] }),
					})
				: undefined;
			if (commandEnvironment) backgroundServices.push(commandEnvironment.backgroundService);
			const commandComposition = commandEnvironment
				? createCodingToolsRuntimeComposition({ cwd: root, environment: commandEnvironment })
				: undefined;
			const compiledCommands = await commandComposition?.compile();
			const passthrough = new PassthroughContextStrategy();
			const snapshot: RuntimeSnapshot = {
				...compiledCommands?.snapshot,
				id: "native-product",
				instructions: [],
				tools: new Map([
					...(compiledCommands?.snapshot.tools ?? []),
					...tools.map((tool) => [tool.name, tool] as const),
				]),
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
						if (options.authorize) return options.authorize(request, signal);
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
				dispose: async () => {
					await commandEnvironment?.backgroundService.shutdown();
					await compiledCommands?.dispose();
					commandComposition?.dispose();
				},
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
		backgroundServices,
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

const COMMAND_TOOL = process.platform === "win32" ? "shell" : "bash";

function interactiveCommand(root: string): string {
	return [
		"const fs = require('node:fs');",
		"process.stdin.setEncoding('utf8');",
		`process.stdin.on('data', text => { fs.appendFileSync(${JSON.stringify(join(root, "stdin-received.txt"))}, text); process.stdout.write('echo:' + text); });`,
		"process.stdin.on('end', () => process.stdout.write('EOF\\n'));",
	].join("\n");
}

function commandTaskId(session: RuntimeSession): string {
	const result = session
		.readMessages()
		.find((message) => message.role === "toolResult" && message.toolName === COMMAND_TOOL);
	assert.ok(result?.role === "toolResult" && result.details && typeof result.details === "object");
	assert.ok("backgroundTaskId" in result.details && typeof result.details.backgroundTaskId === "string");
	return result.details.backgroundTaskId;
}

describe.skipIf(process.platform === "win32")("Native interactive commands through the real Responses provider", () => {
	it("waits for a real foreground command to exit before native cancellation completes", async () => {
		const f = await fixture(
			[
				{
					type: "tool",
					name: COMMAND_TOOL,
					arguments: {
						command: "process.stdout.write('native-foreground-pid:' + process.pid); setInterval(() => {}, 1000)",
						timeout: 15,
					},
				},
			],
			{ commandTools: true, authorize: async () => true },
		);
		try {
			const session = await f.open();
			const ready = deferred<number>();
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "tool.update" || event.toolName !== COMMAND_TOOL) return;
				const match = JSON.stringify(event.partialResult).match(/native-foreground-pid:(\d+)/);
				if (match) ready.resolve(Number(match[1]));
			});
			try {
				const running = session.prompt({ text: "Run bounded work until I stop", inputId: "foreground-cancel" });
				const pid = await ready.promise;
				assert.doesNotThrow(() => process.kill(pid, 0));
				assert.equal(
					f.backgroundServices[0].list().length,
					0,
					"Explicit ordinary timeout must use the foreground port",
				);
				await session.abort("Stop foreground work");
				assert.equal((await running).status, "cancelled");
				assert.throws(() => process.kill(pid, 0));
				assert.equal(session.readState().isStreaming, false);
				assert.deepEqual(f.provider.failures, []);
			} finally {
				unsubscribe();
			}
		} finally {
			await f.close();
		}
	});

	it("keeps one owned process across turns and authorizes every stdin write before EOF and history restore", async () => {
		let taskId = "";
		const approved: string[] = [];
		const f = await fixture(
			(root) => [
				{
					type: "tool",
					name: COMMAND_TOOL,
					arguments: { command: interactiveCommand(root), interactive: true, timeout: 15 },
				},
				{ type: "text", text: "The command is waiting for input." },
				{ type: "tool", name: "task_input", arguments: () => ({ task_id: taskId, input: "first\n", wait_ms: 0 }) },
				{
					type: "tool",
					name: "task_input",
					arguments: () => ({ task_id: taskId, input: "second\n", close_stdin: true, wait_ms: 5000 }),
				},
				{ type: "tool", name: "task_output", arguments: () => ({ task_id: taskId, from_start: true }) },
				{ type: "text", text: "The command received both inputs and finished." },
			],
			{
				commandTools: true,
				authorize: async (request) => {
					approved.push(request.toolName);
					return true;
				},
			},
		);
		try {
			const session = await f.open();
			assert.equal(
				(await session.prompt({ text: "Start the interactive command", inputId: "start-command" })).status,
				"completed",
			);
			taskId = commandTaskId(session);
			assert.equal(f.backgroundServices[0].get(taskId)?.status, "running");
			assert.equal(session.readState().isStreaming, false);
			assert.equal(
				(await session.prompt({ text: "Send both lines and finish", inputId: "feed-command" })).status,
				"completed",
			);
			assert.equal(await readFile(join(f.root, "stdin-received.txt"), "utf8"), "first\nsecond\n");
			assert.equal(f.backgroundServices[0].get(taskId)?.status, "completed");
			assert.deepEqual(approved, [COMMAND_TOOL, "task_input", "task_input", "task_output"]);
			const toolResults = session.readMessages().filter((message) => message.role === "toolResult");
			assert.equal(toolResults.length, 4);
			assert.ok(toolResults.every((message) => !message.isError));
			assert.ok(JSON.stringify(toolResults.at(-1)?.content).includes("EOF"));
			const before = session.readMessages();
			await session.dispose();
			const restored = await f.open(true);
			assert.deepEqual(restored.readMessages(), before);
			assert.equal(
				f.backgroundServices[1].list().length,
				0,
				"Restoring history must not restart or rebind a process",
			);
			assert.deepEqual(f.provider.failures, []);
		} finally {
			await f.close();
		}
	});

	it("denies new stdin independently of the earlier command approval and joins process cleanup on session disposal", async () => {
		let taskId = "";
		const approved: string[] = [];
		const f = await fixture(
			(root) => [
				{
					type: "tool",
					name: COMMAND_TOOL,
					arguments: { command: interactiveCommand(root), interactive: true, timeout: 15 },
				},
				{ type: "text", text: "Ready for input." },
				{
					type: "tool",
					name: "task_input",
					arguments: () => ({ task_id: taskId, input: "must not execute\n", wait_ms: 0 }),
				},
				{ type: "text", text: "The input was denied." },
			],
			{
				commandTools: true,
				authorize: async (request) => {
					approved.push(request.toolName);
					return request.toolName !== "task_input";
				},
			},
		);
		try {
			const session = await f.open();
			assert.equal((await session.prompt({ text: "Start", inputId: "denied-start" })).status, "completed");
			taskId = commandTaskId(session);
			assert.equal(
				(await session.prompt({ text: "Try to provide input", inputId: "denied-input" })).status,
				"completed",
			);
			assert.deepEqual(approved, [COMMAND_TOOL, "task_input"]);
			assert.ok(
				session
					.readMessages()
					.some(
						(message) => message.role === "toolResult" && message.toolName === "task_input" && message.isError,
					),
			);
			await assert.rejects(readFile(join(f.root, "stdin-received.txt")), { code: "ENOENT" });
			await session.dispose();
			assert.equal(f.backgroundServices[0].get(taskId)?.status, "killed");
			await assert.rejects(readFile(join(f.root, "stdin-received.txt")), { code: "ENOENT" });
			assert.deepEqual(f.provider.failures, []);
		} finally {
			await f.close();
		}
	});

	it("cancels pending stdin approval without writing when permission arrives late", async () => {
		let taskId = "";
		const inputRequested = deferred<AbortSignal>();
		const inputDecision = deferred<boolean>();
		const f = await fixture(
			(root) => [
				{
					type: "tool",
					name: COMMAND_TOOL,
					arguments: { command: interactiveCommand(root), interactive: true, timeout: 15 },
				},
				{ type: "text", text: "Ready for input." },
				{
					type: "tool",
					name: "task_input",
					arguments: () => ({ task_id: taskId, input: "late input\n", wait_ms: 0 }),
				},
			],
			{
				commandTools: true,
				authorize: async (request, signal) => {
					if (request.toolName !== "task_input") return true;
					inputRequested.resolve(signal);
					return inputDecision.promise;
				},
			},
		);
		try {
			const session = await f.open();
			assert.equal((await session.prompt({ text: "Start", inputId: "cancel-input-start" })).status, "completed");
			taskId = commandTaskId(session);
			const pending = session.prompt({ text: "Provide input", inputId: "cancel-input" });
			const signal = await inputRequested.promise;
			await session.abort("Cancel input approval");
			assert.equal(signal.aborted, true);
			inputDecision.resolve(true);
			assert.equal((await pending).status, "cancelled");
			await assert.rejects(readFile(join(f.root, "stdin-received.txt")), { code: "ENOENT" });
			assert.equal(
				f.backgroundServices[0].get(taskId)?.status,
				"running",
				"A pending approval owns no input operation to cancel",
			);
			await session.dispose();
			assert.equal(f.backgroundServices[0].get(taskId)?.status, "killed");
			assert.deepEqual(f.provider.failures, []);
		} finally {
			inputDecision.resolve(false);
			await f.close();
		}
	});
});
