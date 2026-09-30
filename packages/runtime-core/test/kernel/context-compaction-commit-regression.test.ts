import type { Message, UserMessage } from "@vetta/ai";
import { describe, expect, it } from "vitest";
import {
	applyStoredEventToConversationDocument,
	type ConversationDocument,
	createEmptyConversationDocument,
	selectConversationDocumentMessages,
	selectConversationDocumentModelMessages,
} from "../../src/conversation/index.js";
import {
	ContextCompactionCommitter,
	type ContextCompactionRecord,
	type ContextPreparationInput,
	type ConversationRepository,
	type CreateConversationInput,
	createAgentSession,
	type KernelEvent,
	type ManualContextCompactionRuntime,
	type RuntimeSnapshot,
	resumeAgentSession,
	StaticRuntimeSnapshotProvider,
	type StoredConversation,
	type StoredSessionEvent,
	type TurnEngineEvent,
	type TurnEnginePort,
	TurnPipeline,
} from "../../src/kernel/index.js";
import { toRuntimeMessageEnvelope } from "../../src/kernel/runtime-message-context.js";
import { KernelRuntimeSessionContextController } from "../../src/runtime-host/index.js";

class CompactionRepository implements ConversationRepository {
	private conversation: StoredConversation | undefined;
	private document: ConversationDocument | undefined;
	failCompactionAppend = false;
	private refreshPending = false;

	async create(input: CreateConversationInput) {
		this.document = createEmptyConversationDocument(input);
		this.conversation = { ...input, version: 0, messages: [], events: [] };
		return this.conversation;
	}

	async load(_sessionId: string): Promise<StoredConversation> {
		if (!this.conversation) throw new Error("Conversation not created");
		return this.conversation;
	}

	async readDocument(_sessionId: string): Promise<ConversationDocument> {
		if (this.refreshPending) {
			this.refreshPending = false;
			throw new Error("Compaction document refresh failed");
		}
		if (!this.document) throw new Error("Document not created");
		return this.document;
	}

	async append(sessionId: string, expectedVersion: number, events: readonly StoredSessionEvent[]) {
		const conversation = await this.load(sessionId);
		if (conversation.version !== expectedVersion) throw new Error("Version mismatch");
		const compacting = events.some((event) => event.type === "context.compacted");
		if (compacting && this.failCompactionAppend) throw new Error("Compaction append failed");
		if (!this.document) throw new Error("Document not created");
		let document = this.document;
		let version = expectedVersion;
		for (const event of events) document = applyStoredEventToConversationDocument(document, event, ++version);
		this.document = document;
		this.conversation = {
			...conversation,
			version,
			messages: selectConversationDocumentMessages(document),
			events: [...conversation.events, ...events],
		};
		if (compacting) this.refreshPending = true;
		return { version };
	}

	async saveSnapshot(): Promise<void> {}
	async close(): Promise<void> {}
}

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function record(document: ConversationDocument, reason: ContextCompactionRecord["reason"]): ContextCompactionRecord {
	const firstKept = document.entries.filter((entry) => entry.type === "message").at(-1);
	if (!firstKept) throw new Error("Expected history to compact");
	return {
		summary: "summary",
		summaryMessage: user("summary"),
		firstKeptEntryId: firstKept.id,
		tokensBefore: 100,
		reason,
	};
}

async function createHarness(compactionPhase: ContextPreparationInput["reason"] = "turn_start") {
	const repository = new CompactionRepository();
	const events: KernelEvent[] = [];
	const committedDocuments: Array<ConversationDocument | undefined> = [];
	const modelMessages: Array<readonly Message[]> = [];
	let compact = false;
	let failExecution = false;
	let onPublished: ((event: KernelEvent) => void) | undefined;
	let turn = 0;
	const eventSink = {
		async publish(event: KernelEvent) {
			events.push(event);
			onPublished?.(event);
		},
	};
	const clock = { now: () => 100 };
	const committer = new ContextCompactionCommitter({
		repository,
		conversationDocumentReader: repository,
		eventSink,
		clock,
	});
	const manualRuntime: ManualContextCompactionRuntime = {
		readAutoCompactionEnabled: () => true,
		setAutoCompactionEnabled() {},
		async compactManual(input) {
			return record(input.document, "manual");
		},
		async onManualCompactionCommitted(_record, _input, _signal, document) {
			committedDocuments.push(document);
		},
	};
	const snapshot: RuntimeSnapshot = {
		id: "snapshot",
		instructions: [],
		tools: new Map(),
		contextProviders: [],
		contextStrategy: {
			async prepare(input) {
				if (
					!compact ||
					input.reason !== compactionPhase ||
					!input.document ||
					input.document.entries.some((entry) => entry.type === "compaction")
				) {
					return { messages: input.messages, estimatedTokens: input.messages.length };
				}
				return {
					messages: [user("summary"), ...input.messages.slice(input.reason === "turn_start" ? -2 : -1)],
					estimatedTokens: 2,
					compaction: record(input.document, "threshold"),
				};
			},
			async onCompactionCommitted(_record, _input, _signal, document) {
				committedDocuments.push(document);
				return { continueExecution: true };
			},
		},
		conversationContextProjector: {
			project: (document) => selectConversationDocumentModelMessages(document).map(toRuntimeMessageEnvelope),
		},
		manualCompactionStrategy: manualRuntime,
		toolPolicy: { authorize: async () => true },
		tokenBudget: 1000,
		reservedOutputTokens: 100,
		observers: [],
	};
	const snapshotProvider = new StaticRuntimeSnapshotProvider(snapshot);
	const engine: TurnEnginePort = {
		async *execute(request): AsyncIterable<TurnEngineEvent> {
			const checkpoint = await request.checkpoint?.(
				{ reason: "model_call", messages: request.messages, modelCallIndex: 0, recoveryAttempt: 0 },
				request.signal,
			);
			modelMessages.push(checkpoint?.messages ?? request.messages);
			if (failExecution) throw new Error("Provider unavailable after compaction");
			yield { type: "completed", stopReason: "stop" };
		},
	};
	const pipeline = new TurnPipeline({
		repository,
		conversationDocumentReader: repository,
		contextCompactionCommitter: committer,
		snapshotProvider,
		turnEngine: engine,
		eventSink,
		clock,
		idGenerator: { next: () => `turn-${++turn}` },
	});
	const session = await createAgentSession({ id: "session", pipeline });
	const manualController = new KernelRuntimeSessionContextController({
		session,
		repository,
		conversationDocumentReader: repository,
		snapshotProvider,
		contextRuntime: manualRuntime,
		committer,
	});
	await expect(session.send({ message: user("old history") })).resolves.toMatchObject({ status: "completed" });
	await expect(session.send({ message: user("kept history") })).resolves.toMatchObject({ status: "completed" });
	return {
		repository,
		committer,
		events,
		committedDocuments,
		modelMessages,
		pipeline,
		session,
		manualController,
		enableCompaction: () => {
			compact = true;
		},
		setExecutionFailure: (value: boolean) => {
			failExecution = value;
		},
		onPublished: (callback: (event: KernelEvent) => void) => {
			onPublished = callback;
		},
	};
}

function expectRefreshFailure(events: readonly KernelEvent[]) {
	expect(events).toContainEqual(
		expect.objectContaining({
			type: "observer.failed",
			observerId: "context-compaction.document-refresh",
			error: "Compaction document refresh failed",
		}),
	);
	expect(events).not.toContainEqual(
		expect.objectContaining({
			type: "session.observation",
			observation: expect.objectContaining({ type: "compaction.end", success: false }),
		}),
	);
}

describe("compaction durable commit boundary", () => {
	it("returns the durable version when an optional document refresh and its diagnostic sink fail", async () => {
		const harness = await createHarness();
		const before = await harness.repository.load("session");
		const document = await harness.repository.readDocument("session");
		harness.onPublished(() => {
			throw new Error("Event sink unavailable");
		});

		await expect(
			harness.committer.commit({
				sessionId: "session",
				expectedVersion: before.version,
				record: record(document, "manual"),
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ version: before.version + 1, document: undefined });

		expect((await harness.repository.load("session")).events.at(-1)?.type).toBe("context.compacted");
		expectRefreshFailure(harness.events);
		await harness.session.close();
	});

	it.each(["turn_start", "model_call"] as const)(
		"finishes %s compaction and resumes with its durable projection after a refresh failure",
		async (phase) => {
			const harness = await createHarness(phase);
			harness.enableCompaction();

			await expect(harness.session.send({ message: user("current input") })).resolves.toMatchObject({
				status: "completed",
			});

			expect(harness.committedDocuments).toEqual([undefined]);
			expectRefreshFailure(harness.events);
			await harness.session.close();
			const resumed = await resumeAgentSession({ id: "session", pipeline: harness.pipeline });
			await expect(resumed.send({ message: user("follow up") })).resolves.toMatchObject({ status: "completed" });
			const conversation = await harness.repository.load("session");
			expect(conversation.events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
			expect(conversation.events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
			expect(harness.modelMessages.at(-1)?.map((message) => message.content)).toContain("summary");
			expect(harness.modelMessages.at(-1)?.map((message) => message.content)).not.toContain("old history");
			await resumed.close();
		},
	);

	it("returns manual compaction success and keeps the compacted history on the next prompt", async () => {
		const harness = await createHarness();

		await expect(harness.manualController.compact()).resolves.toMatchObject({
			summary: "summary",
			tokensBefore: 100,
		});

		expect(harness.manualController.readState().isCompacting).toBe(false);
		expect(harness.committedDocuments).toEqual([undefined]);
		expectRefreshFailure(harness.events);
		await expect(harness.session.send({ message: user("follow up") })).resolves.toMatchObject({
			status: "completed",
		});
		expect(harness.modelMessages.at(-1)?.map((message) => message.content)).toEqual([
			"summary",
			"kept history",
			"follow up",
		]);
		expect(
			(await harness.repository.load("session")).events.filter((event) => event.type === "context.compacted"),
		).toHaveLength(1);
		await harness.session.close();
	});

	it("does not compact again when a real execution failure is retried after reopening", async () => {
		const harness = await createHarness("model_call");
		harness.enableCompaction();
		harness.setExecutionFailure(true);

		await expect(harness.session.send({ message: user("current input") })).resolves.toMatchObject({
			status: "failed",
			error: { message: "Provider unavailable after compaction" },
		});

		expect(harness.committedDocuments).toEqual([undefined]);
		expectRefreshFailure(harness.events);
		harness.setExecutionFailure(false);
		await harness.session.close();
		const resumed = await resumeAgentSession({ id: "session", pipeline: harness.pipeline });
		await expect(resumed.retry()).resolves.toMatchObject({ status: "completed" });
		expect(harness.modelMessages.at(-1)?.map((message) => message.content)).toEqual(["summary", "current input"]);
		expect(
			(await harness.repository.load("session")).events.filter((event) => event.type === "context.compacted"),
		).toHaveLength(1);
		await resumed.close();
	});

	it("preserves committed compaction when cancellation arrives before the failed refresh", async () => {
		const harness = await createHarness();
		const controller = new AbortController();
		harness.enableCompaction();
		harness.onPublished((event) => {
			if (event.type === "context.compacted") controller.abort("Cancel after durable compaction");
		});

		await expect(
			harness.pipeline.run("session", { message: user("current input") }, controller.signal),
		).resolves.toMatchObject({ status: "cancelled", reason: "Cancel after durable compaction" });

		expectRefreshFailure(harness.events);
		const conversation = await harness.repository.load("session");
		expect(conversation.events.filter((event) => event.type === "context.compacted")).toHaveLength(1);
		expect(conversation.events.at(-1)?.type).toBe("turn.cancelled");
		await harness.session.close();
		const resumed = await resumeAgentSession({ id: "session", pipeline: harness.pipeline });
		expect((await harness.repository.load("session")).version).toBe(conversation.version);
		await resumed.close();
	});

	it("recovers an interrupted turn without replaying its committed compaction", async () => {
		const harness = await createHarness("model_call");
		harness.enableCompaction();
		const before = await harness.repository.load("session");
		const appended = await harness.repository.append("session", before.version, [
			{ type: "turn.started", sessionId: "session", turnId: "interrupted", snapshotId: "snapshot", timestamp: 100 },
			{
				type: "message.appended",
				sessionId: "session",
				turnId: "interrupted",
				message: user("current input"),
				timestamp: 100,
			},
		]);
		const document = await harness.repository.readDocument("session");
		await expect(
			harness.committer.commit({
				sessionId: "session",
				turnId: "interrupted",
				expectedVersion: appended.version,
				record: record(document, "threshold"),
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({ version: appended.version + 1 });
		await harness.session.close();

		const resumed = await resumeAgentSession({ id: "session", pipeline: harness.pipeline });
		const recovered = await harness.repository.load("session");
		expect(recovered.events.at(-1)).toMatchObject({ type: "turn.failed", turnId: "interrupted" });
		await resumed.close();
		const reopened = await resumeAgentSession({ id: "session", pipeline: harness.pipeline });
		expect((await harness.repository.load("session")).version).toBe(recovered.version);
		await expect(reopened.retry()).resolves.toMatchObject({ status: "completed" });
		expect(harness.modelMessages.at(-1)?.map((message) => message.content)).toEqual(["summary", "current input"]);
		expect(
			(await harness.repository.load("session")).events.filter((event) => event.type === "context.compacted"),
		).toHaveLength(1);
		await reopened.close();
	});

	it("still rejects an uncommitted append and never runs committed callbacks", async () => {
		const harness = await createHarness();
		harness.repository.failCompactionAppend = true;
		const before = await harness.repository.load("session");

		await expect(harness.manualController.compact()).rejects.toThrow("Compaction append failed");

		expect((await harness.repository.load("session")).version).toBe(before.version);
		expect(harness.committedDocuments).toEqual([]);
		expect(harness.events.some((event) => event.type === "context.compacted")).toBe(false);
		expect(harness.manualController.readState().isCompacting).toBe(false);
		harness.repository.failCompactionAppend = false;
		await expect(harness.manualController.compact()).resolves.toMatchObject({ summary: "summary" });
		expect(
			(await harness.repository.load("session")).events.filter((event) => event.type === "context.compacted"),
		).toHaveLength(1);
		await harness.session.close();
	});
});
