import type {
	RuntimeExecutionComposer,
	RuntimeHostSessionAssembly,
	RuntimeHostSessionBackend,
	RuntimeTurnPrompt,
} from "@vetta/runtime-core";
import type { RuntimeSnapshot, TurnEnginePort } from "@vetta/runtime-core/kernel";
import type { SessionRuntimeBackend, SessionRuntimeBackendState } from "../../shared/session-runtime-backend.js";
import { RUNTIME_BACKEND_ENTRY, RuntimeBackendError, readRuntimeBackendChoice } from "./runtime-backend-choice.js";

interface RegisteredConversation {
	readonly assembly: RuntimeHostSessionAssembly;
	switching?: Promise<SessionRuntimeBackendState>;
	closed: boolean;
}
export interface RuntimeBackendSelectionOptions {
	readonly codex: TurnEnginePort;
	/** The host validates installed resources and existing model settings, not renderer-supplied paths/keys. */
	validateCodex(assembly: RuntimeHostSessionAssembly): Promise<void>;
	assertReusable(sessionId: string): void;
}

/** Owns backend selection only. Neither history, draft, agent loop nor session identity is replaced. */
export class ConversationRuntimeBackendSelection {
	private readonly conversations = new Set<RegisteredConversation>();
	private readonly listeners = new Set<(state: SessionRuntimeBackendState) => void>();
	constructor(private readonly options: RuntimeBackendSelectionOptions) {}

	readonly composeExecution: RuntimeExecutionComposer = (resources, native) => {
		const bindings = new Map<string, TurnEnginePort>();
		return {
			snapshotProvider: {
				acquire: async (context) => {
					this.options.assertReusable(context.sessionId);
					const owner = this.find(context.sessionId);
					if (owner?.closed || owner?.switching) throw new RuntimeBackendError("RUNTIME_SWITCHING");
					const acquisition = native.snapshotProvider.acquire(context);
					const lease = await acquisition;
					try {
						const choice = readRuntimeBackendChoice(
							await resources.conversationDocumentStore.readDocument(context.sessionId),
						);
						if (choice.backend === "codex" && context.reason !== "turn" && context.reason !== "preview") {
							throw new RuntimeBackendError("CODEX_CONTEXT_MANAGED");
						}
						const snapshot = choice.backend === "codex" ? codexSnapshot(lease.snapshot) : lease.snapshot;
						bindings.set(
							context.operationId,
							choice.backend === "codex" ? this.options.codex : native.turnEngine,
						);
						return {
							...lease,
							snapshot,
							release: async () => {
								try {
									await lease.release();
								} finally {
									bindings.delete(context.operationId);
								}
							},
						};
					} catch (error) {
						await lease.release();
						throw error;
					}
				},
			},
			turnEngine: {
				execute: (request) => {
					const engine = bindings.get(request.turnId);
					if (!engine) throw new RuntimeBackendError("RUNTIME_BINDING_MISSING");
					return engine.execute(request);
				},
			},
		};
	};

	decorateBackend(backend: RuntimeHostSessionBackend): RuntimeHostSessionBackend {
		return {
			createAssembly: async (request) => {
				const assembly = await backend.createAssembly(request);
				if (!assembly.conversationView || !assembly.metadataController) return assembly;
				const owner: RegisteredConversation = { assembly, closed: false };
				this.conversations.add(owner);
				const original = assembly.corePorts.turnControl;
				const guard = (prompt?: RuntimeTurnPrompt) => this.guard(owner, prompt);
				let closing: Promise<void> | undefined;
				return {
					...assembly,
					lifecycle: {
						...assembly.lifecycle,
						get sessionId() {
							return assembly.lifecycle.sessionId;
						},
						get sessionPath() {
							return assembly.lifecycle.sessionPath;
						},
						dispose: () => {
							if (closing) return closing;
							owner.closed = true;
							closing = (async () => {
								await owner.switching?.catch(() => undefined);
								await assembly.lifecycle.dispose();
								this.conversations.delete(owner);
							})();
							return closing;
						},
					},
					corePorts: {
						...assembly.corePorts,
						turnControl: {
							...original,
							prompt: async (prompt) => {
								guard(prompt);
								return original.prompt(prompt);
							},
							promptWhenAvailable: async (prompt, signal) => {
								guard(prompt);
								return original.promptWhenAvailable(prompt, signal);
							},
							queuePromptIfRunning: async (prompt) => {
								guard(prompt);
								return original.queuePromptIfRunning(prompt);
							},
							continue: async () => {
								guard();
								return original.continue();
							},
							retry: async () => {
								guard();
								return original.retry();
							},
						},
					},
					executionController: {
						isBusy: () => !!owner.switching || assembly.executionController.isBusy(),
						reconfigure: (update) => {
							guard();
							return assembly.executionController.reconfigure(update);
						},
					},
				};
			},
			dispose: () => backend.dispose?.() ?? Promise.resolve(),
		};
	}

	assemblyFor(sessionId: string): RuntimeHostSessionAssembly {
		return this.require(sessionId).assembly;
	}

	read(sessionId: string): SessionRuntimeBackendState {
		const owner = this.require(sessionId);
		return {
			sessionId,
			...readRuntimeBackendChoice(owner.assembly.conversationView!.readDocument()),
			busy: this.busy(owner),
			switching: !!owner.switching,
		};
	}

	select(
		sessionId: string,
		backend: SessionRuntimeBackend,
		expectedSelectionId: string,
	): Promise<SessionRuntimeBackendState> {
		const owner = this.require(sessionId);
		this.options.assertReusable(sessionId);
		if (owner.switching || this.busy(owner)) return Promise.reject(new RuntimeBackendError("SESSION_BUSY"));
		const current = this.read(sessionId);
		if (current.selectionId !== expectedSelectionId)
			return Promise.reject(new RuntimeBackendError("RUNTIME_SELECTION_CONFLICT"));
		if (current.backend === backend) return Promise.resolve(current);
		const revision = owner.assembly.conversationView!.readDocument().revision;
		const work = Promise.resolve().then(async () => {
			if (backend === "codex") await this.options.validateCodex(owner.assembly);
			if (owner.closed) throw new RuntimeBackendError("SESSION_CLOSED");
			if (this.busy(owner)) throw new RuntimeBackendError("SESSION_BUSY");
			if (owner.assembly.conversationView!.readDocument().revision !== revision)
				throw new RuntimeBackendError("RUNTIME_SELECTION_CONFLICT");
			await owner.assembly.metadataController!.appendEntry(RUNTIME_BACKEND_ENTRY, { schemaVersion: 1, backend });
			return { ...this.read(sessionId), switching: false };
		});
		owner.switching = work;
		this.notify(this.read(sessionId));
		void work.then(
			() => this.settled(owner),
			() => this.settled(owner),
		);
		return work;
	}

	subscribe(listener: (state: SessionRuntimeBackendState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private settled(owner: RegisteredConversation): void {
		owner.switching = undefined;
		if (!owner.closed) {
			try {
				this.notify(this.read(owner.assembly.lifecycle.sessionId));
			} catch {
				/* A corrupt document remains an explicit read failure. */
			}
		}
	}
	private notify(state: SessionRuntimeBackendState): void {
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch {
				/* Observation is not admission. */
			}
		}
	}
	private find(id: string) {
		return [...this.conversations].find((owner) => owner.assembly.lifecycle.sessionId === id);
	}
	private require(id: string): RegisteredConversation {
		const owner = this.find(id);
		if (!owner || owner.closed) throw new RuntimeBackendError("SESSION_UNAVAILABLE");
		return owner;
	}
	private busy(owner: RegisteredConversation): boolean {
		return (
			owner.assembly.executionController.isBusy() ||
			!!owner.assembly.contextController?.readState().isCompacting ||
			(owner.assembly.queueController?.readQueueState().entries.length ?? 0) > 0
		);
	}
	private guard(owner: RegisteredConversation, prompt?: RuntimeTurnPrompt): void {
		if (owner.closed) throw new RuntimeBackendError("SESSION_CLOSED");
		if (owner.switching) throw new RuntimeBackendError("RUNTIME_SWITCHING");
		this.options.assertReusable(owner.assembly.lifecycle.sessionId);
		if (readRuntimeBackendChoice(owner.assembly.conversationView!.readDocument()).backend !== "codex") return;
		if (
			prompt?.images?.length ||
			prompt?.attachments?.length ||
			prompt?.promptRef ||
			prompt?.metadata?.knowledgeMode ||
			prompt?.metadata?.pluginPromptContexts ||
			prompt?.metadata?.pluginInstructions
		) {
			throw new RuntimeBackendError("CODEX_CAPABILITY_UNSUPPORTED");
		}
		if (prompt?.streamingBehavior === "steer") throw new RuntimeBackendError("CODEX_STEERING_UNAVAILABLE");
	}
}

/** Keep the native model/input binding and canonical context projection, but do not
 * compose a second tool catalog, model loop, compactor or stop-hook continuation. */
function codexSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
	return {
		...snapshot,
		tools: new Map(),
		instructions: [],
		modelCallProviders: [],
		modelCallFrameComposer: undefined,
		agentRunPreparer: undefined,
		continuationPolicy: undefined,
		modelCallContextTransformer: undefined,
		modelCallMessageFinalizer: undefined,
		manualCompactionStrategy: undefined,
		contextSummaryStrategy: undefined,
		contextProviders: [],
		contextStrategy: {
			prepare: async (input, signal) => {
				signal.throwIfAborted();
				return { messages: input.messages, estimatedTokens: Math.ceil(JSON.stringify(input.messages).length / 4) };
			},
		},
	};
}
