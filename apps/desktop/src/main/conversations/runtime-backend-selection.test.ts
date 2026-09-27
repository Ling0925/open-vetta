import assert from "node:assert/strict";
import type { RuntimeHostSessionAssembly, RuntimeHostSessionBackend, RuntimeResources } from "@vetta/runtime-core";
import type { ConversationDocument } from "@vetta/runtime-core/conversation";
import type { RuntimeSnapshot, TurnEnginePort } from "@vetta/runtime-core/kernel";
import { describe, it } from "vitest";
import { RUNTIME_BACKEND_ENTRY, readRuntimeBackendChoice } from "./runtime-backend-choice.js";
import { ConversationRuntimeBackendSelection } from "./runtime-backend-selection.js";

function latch() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function fixture(validate: () => Promise<void> = async () => {}) {
	let document = { entries: [], revision: 0 } as unknown as ConversationDocument;
	let busy = false;
	let dispatched = 0;
	let disposed = 0;
	let released = 0;
	const calls: string[] = [];
	const engine = (name: string): TurnEnginePort => ({
		async *execute() {
			calls.push(name);
			yield { type: "completed", stopReason: "stop" };
		},
	});
	const native = engine("native");
	const codex = engine("codex");
	const selection = new ConversationRuntimeBackendSelection({ codex, validateCodex: validate, assertReusable() {} });
	const original = {
		lifecycle: {
			sessionId: "same-session",
			sessionPath: "/conversation/original",
			dispose: async () => {
				disposed++;
			},
		},
		conversationView: { readDocument: () => document },
		metadataController: {
			appendEntry: async (customType: string, data: unknown) => {
				document = {
					...document,
					revision: document.revision + 1,
					entries: [
						...document.entries,
						{ id: `selection-${document.revision + 1}`, type: "custom", customType, data },
					],
				} as ConversationDocument;
			},
		},
		executionController: { isBusy: () => busy, reconfigure() {} },
		corePorts: {
			turnControl: {
				prompt: async () => {
					dispatched++;
					return { status: "completed" };
				},
			},
		},
	} as unknown as RuntimeHostSessionAssembly;
	const backend = selection.decorateBackend({ createAssembly: async () => original } as RuntimeHostSessionBackend);
	return {
		selection,
		backend,
		original,
		native,
		calls,
		readDocument: () => document,
		busy: (value: boolean) => {
			busy = value;
		},
		counts: () => ({ dispatched, disposed, released }),
		compose: (snapshot?: RuntimeSnapshot) =>
			selection.composeExecution(
				// This unit fixture replaces only the document-store boundary read by the composer.
				{ conversationDocumentStore: { readDocument: async () => document } } as unknown as RuntimeResources,
				{
					turnEngine: native,
					snapshotProvider: {
						acquire: async () => ({
							snapshot:
								snapshot ??
								({
									tools: new Map(),
									instructions: [],
									contextProviders: [],
								} as unknown as RuntimeSnapshot),
							release: async () => {
								released++;
							},
						}),
					},
				},
			),
	};
}
async function open(f: ReturnType<typeof fixture>) {
	return f.backend.createAssembly({ executionMode: "sandbox", getSessionId: () => undefined });
}

describe("same-conversation backend ownership", () => {
	it("preserves an absent optional queue capability instead of installing an unusable method", async () => {
		const f = fixture();
		const session = await open(f);
		try {
			assert.equal(session.corePorts.turnControl.queuePromptIfRunning, undefined);
		} finally {
			await session.lifecycle.dispose();
		}
	});
	it("switches both directions, preserving the original identity and persisting only metadata", async () => {
		const f = fixture();
		const session = await open(f);
		assert.equal(f.selection.read("same-session").backend, "native");
		const switched = await f.selection.select("same-session", "codex", "default");
		assert.equal(switched.backend, "codex");
		assert.equal(session.lifecycle.sessionPath, "/conversation/original");
		assert.equal((await f.selection.select("same-session", "native", switched.selectionId)).backend, "native");
		assert.equal(f.readDocument().entries.length, 2);
		assert.equal(f.counts().dispatched, 0);
		await session.lifecycle.dispose();
	});
	it("does not change selection when preflight fails", async () => {
		const f = fixture(async () => {
			throw new Error("missing binary");
		});
		const session = await open(f);
		await assert.rejects(f.selection.select("same-session", "codex", "default"), /missing binary/);
		assert.equal(f.selection.read("same-session").backend, "native");
		assert.equal(f.readDocument().entries.length, 0);
		await session.lifecycle.dispose();
	});
	it("blocks sends and competing switches while validation is pending", async () => {
		const gate = latch();
		const f = fixture(() => gate.promise);
		const session = await open(f);
		const switching = f.selection.select("same-session", "codex", "default");
		await assert.rejects(session.corePorts.turnControl.prompt({ text: "must not dispatch" }), {
			code: "RUNTIME_SWITCHING",
		});
		await assert.rejects(f.selection.select("same-session", "native", "default"), { code: "SESSION_BUSY" });
		assert.equal(f.counts().dispatched, 0);
		gate.resolve();
		await switching;
		await session.lifecycle.dispose();
	});
	it("rejects switching active tasks and stale expected selections", async () => {
		const f = fixture();
		const session = await open(f);
		f.busy(true);
		await assert.rejects(f.selection.select("same-session", "codex", "default"), { code: "SESSION_BUSY" });
		f.busy(false);
		await f.selection.select("same-session", "codex", "default");
		await assert.rejects(f.selection.select("same-session", "native", "default"), {
			code: "RUNTIME_SELECTION_CONFLICT",
		});
		await session.lifecycle.dispose();
	});
	it("does not commit a pending switch after the original session is closed", async () => {
		const gate = latch();
		const f = fixture(() => gate.promise);
		const session = await open(f);
		const pending = assert.rejects(f.selection.select("same-session", "codex", "default"), {
			code: "SESSION_CLOSED",
		});
		const closing = session.lifecycle.dispose();
		gate.resolve();
		await Promise.all([pending, closing]);
		assert.equal(f.readDocument().entries.length, 0);
		assert.equal(f.counts().disposed, 1);
	});
	it("keeps Vetta context management when Codex is selected and permits manual compaction snapshots", async () => {
		const f = fixture();
		const session = await open(f);
		await f.selection.select("same-session", "codex", "default");

		const contextStrategy: RuntimeSnapshot["contextStrategy"] = {
			prepare: async (input) => ({ messages: input.messages, estimatedTokens: 1 }),
		};
		const contextProvider = { id: "shared-context", provide: async () => [] };
		const manualCompactionStrategy = { compactManual: async () => { throw new Error("not executed"); } };
		const contextSummaryStrategy = { summarizeContext: async () => ({ summary: "fixture", tokensBefore: 1 }) };
		const transformer: NonNullable<RuntimeSnapshot["modelCallContextTransformer"]> = {
			transform: async (input) => input.messages,
		};
		const finalizer: NonNullable<RuntimeSnapshot["modelCallMessageFinalizer"]> = {
			finalize: async (input) => input.messages,
		};
		const source = {
			id: "source",
			tools: new Map([["native-only", {}]]),
			instructions: [{ id: "native-only", content: "native loop instruction" }],
			modelCallProviders: [{ id: "native-provider" }],
			modelCallFrameComposer: {},
			agentRunPreparer: {},
			continuationPolicy: {},
			contextProviders: [contextProvider],
			contextStrategy,
			manualCompactionStrategy,
			contextSummaryStrategy,
			modelCallContextTransformer: transformer,
			modelCallMessageFinalizer: finalizer,
			toolPolicy: { authorize: async () => true },
			tokenBudget: 8_000,
			reservedOutputTokens: 1_000,
			observers: [],
		} as unknown as RuntimeSnapshot;
		const composition = f.compose(source);
		const lease = await composition.snapshotProvider.acquire({
			sessionId: "same-session",
			operationId: "same-session:manual-compaction",
			reason: "manual_compaction",
			signal: new AbortController().signal,
		});
		try {
			assert.equal(lease.snapshot.contextStrategy, contextStrategy);
			assert.equal(lease.snapshot.contextProviders[0], contextProvider);
			assert.equal(lease.snapshot.manualCompactionStrategy, manualCompactionStrategy);
			assert.equal(lease.snapshot.contextSummaryStrategy, contextSummaryStrategy);
			assert.equal(lease.snapshot.modelCallContextTransformer, transformer);
			assert.equal(lease.snapshot.modelCallMessageFinalizer, finalizer);
			assert.equal(lease.snapshot.tools.size, 0);
			assert.deepEqual(lease.snapshot.instructions, []);
			assert.deepEqual(lease.snapshot.modelCallProviders, []);
			assert.equal(lease.snapshot.modelCallFrameComposer, undefined);
			assert.equal(lease.snapshot.agentRunPreparer, undefined);
			assert.equal(lease.snapshot.continuationPolicy, undefined);
		} finally {
			await lease.release();
			await session.lifecycle.dispose();
		}
	});

	it("pins the selected engine by operation ID, even when the pipeline copies its snapshot", async () => {
		const f = fixture();
		const session = await open(f);
		const composition = f.compose();
		let sequence = 0;
		for (const backend of ["native", "codex", "native"] as const) {
			await f.selection.select("same-session", backend, f.selection.read("same-session").selectionId);
			const operationId = `turn-${++sequence}`;
			const signal = new AbortController().signal;
			const lease = await composition.snapshotProvider.acquire({
				sessionId: "same-session",
				operationId,
				reason: "turn",
				signal,
			});
			for await (const _event of composition.turnEngine.execute({
				sessionId: "same-session",
				turnId: operationId,
				signal,
				messages: [],
				snapshot: { ...lease.snapshot },
			})) {
				/* Drain actual selected engine. */
			}
			await lease.release();
		}
		assert.deepEqual(f.calls, ["native", "codex", "native"]);
		assert.equal(f.counts().released, 3);
		await session.lifecycle.dispose();
	});
	it("rejects corrupt selection records instead of silently using Native", () => {
		assert.throws(
			() =>
				readRuntimeBackendChoice({
					entries: [
						{ type: "custom", customType: RUNTIME_BACKEND_ENTRY, data: { schemaVersion: 999, backend: "codex" } },
					],
				} as unknown as ConversationDocument),
			{ code: "RUNTIME_SELECTION_INVALID" },
		);
	});
});
