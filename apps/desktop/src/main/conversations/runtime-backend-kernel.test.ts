import assert from "node:assert/strict";
import type { Api, AssistantMessage, Message, Model } from "@vetta/ai";
import {
	ComposedRuntimeFactory,
	KernelRuntimeSessionBackend,
	type RuntimeHostSessionAssembly,
	type RuntimeHostSessionBackend,
	RuntimeModel,
	type RuntimePromptAdapter,
} from "@vetta/runtime-core";
import { selectConversationDocumentModelMessages } from "@vetta/runtime-core/conversation";
import { type RuntimeSnapshot, StaticRuntimeSnapshotProvider, type TurnEnginePort } from "@vetta/runtime-core/kernel";
import { createInMemoryConversationPersistence } from "@vetta/runtime-node/conversation";
import { describe, it } from "vitest";
import { ConversationRuntimeBackendSelection } from "./runtime-backend-selection.js";

const MODEL: Model<Api> = {
	id: "configured",
	name: "Configured",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 8000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const answer = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 2,
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

/** Real ComposedRuntimeFactory, Kernel, canonical repository and metadata ports.
 * Only model/tool engines are fixtures in this test; Codex protocol/engine tests run separately. */
describe("backend changes on a real canonical conversation", () => {
	it("runs Native → Codex → Native → reopen in one conversation without duplicating user input or losing context", async () => {
		const persistence = createInMemoryConversationPersistence();
		const calls: { engine: string; messages: readonly Message[] }[] = [];
		const engine = (name: string): TurnEnginePort => ({
			async *execute(request) {
				calls.push({ engine: name, messages: request.messages });
				yield { type: "message", message: answer(`${name} result`) };
				yield { type: "completed", stopReason: "stop" };
			},
		});
		const native = engine("native");
		const selection = new ConversationRuntimeBackendSelection({
			codex: engine("codex"),
			validateCodex: async () => {},
			assertReusable() {},
		});
		const factory = new ComposedRuntimeFactory<{ id: string }>({
			composeExecution: (resources, base) => selection.composeExecution(resources, { ...base, turnEngine: native }),
			createResources: async (options) => {
				const model = new RuntimeModel({
					initialModel: MODEL,
					initialThinkingLevel: "off",
					catalog: { refresh() {}, listAvailable: () => [MODEL], find: () => MODEL },
					credentials: { resolve: async () => "synthetic", refreshAuth: async () => {} },
				});
				const snapshot: RuntimeSnapshot = {
					id: "captured",
					instructions: [],
					tools: new Map(),
					contextProviders: [],
					contextStrategy: { prepare: async (input) => ({ messages: input.messages, estimatedTokens: 1 }) },
					conversationContextProjector: {
						project: (document) =>
							selectConversationDocumentModelMessages(document).map((message) => ({ kind: "message", message })),
					},
					toolPolicy: { authorize: async () => true },
					tokenBudget: 8000,
					reservedOutputTokens: 1000,
					observers: [],
				};
				const promptAdapter: RuntimePromptAdapter = {
					createRequest: (request) => ({ payload: request, displayText: request.text }),
					prepare: async (request) => ({
						action: "continue",
						input: {
							message: { role: "user", content: (request.payload as { text: string }).text, timestamp: 1 },
						},
					}),
				};
				return {
					sessionId: options.id,
					repository: persistence.repository,
					conversationDocumentStore: persistence.documentStore,
					promptAdapter,
					snapshotProvider: new StaticRuntimeSnapshotProvider(snapshot, model),
					modelRuntime: model,
					identity: { cwd: "/fixture/workspace", sessionPath: `/fixture/${options.id}.conversation.jsonl` },
					stateSource: { read: () => ({ contextPercent: null, contextWindow: 8000, activeToolNames: [] }) },
					createSessionPeripherals: (session) => ({
						executionController: { isBusy: () => session.state !== "idle", reconfigure() {} },
						configurationController: {
							setSteeringMode: (mode) => session.setSteeringMode(mode),
							setFollowUpMode: (mode) => session.setFollowUpMode(mode),
						},
					}),
				};
			},
		});
		const kernelBackend = new KernelRuntimeSessionBackend({ runtimeFactory: factory });
		const backend: RuntimeHostSessionBackend = selection.decorateBackend({
			createAssembly: async (request) => {
				const session = request.sessionPath
					? await kernelBackend.resume({ id: "original" })
					: await kernelBackend.create({ id: "original" });
				const assembly = session.createRuntimeHostAssemblyCandidate();
				assert.ok(assembly.executionController && assembly.configurationController);
				return assembly as RuntimeHostSessionAssembly;
			},
		});
		let session = await backend.createAssembly({ cwd: "/fixture/workspace", getSessionId: () => undefined });
		const path = session.lifecycle.sessionPath;
		try {
			assert.equal((await session.corePorts.turnControl.prompt({ text: "first" }))?.status, "completed");
			await selection.select("original", "codex", selection.read("original").selectionId);
			assert.equal((await session.corePorts.turnControl.prompt({ text: "second" }))?.status, "completed");
			await selection.select("original", "native", selection.read("original").selectionId);
			assert.equal((await session.corePorts.turnControl.prompt({ text: "third" }))?.status, "completed");
			assert.deepEqual(
				calls.map((call) => call.engine),
				["native", "codex", "native"],
			);
			assert.ok(JSON.stringify(calls[1].messages).includes("native result"));
			assert.ok(JSON.stringify(calls[2].messages).includes("codex result"));
			assert.deepEqual(
				calls.map((call) => call.messages.filter((message) => message.role === "user").length),
				[1, 2, 3],
			);
			const history = session.historyReader.readHistory();
			assert.equal(history.filter((row) => row.type === "message").length, 6);
			assert.equal(session.lifecycle.sessionId, "original");
			assert.equal(session.lifecycle.sessionPath, path);
			await session.lifecycle.dispose();
			session = await backend.createAssembly({ sessionPath: path, getSessionId: () => undefined });
			assert.equal(selection.read("original").backend, "native");
			assert.deepEqual(session.historyReader.readHistory(), history);
			assert.equal((await session.corePorts.turnControl.prompt({ text: "after reopen" }))?.status, "completed");
			assert.equal(calls[3].messages.filter((message) => message.role === "user").length, 4);
		} finally {
			await session.lifecycle.dispose();
			await persistence.dispose();
		}
	});
});
