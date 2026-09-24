import { randomUUID } from "node:crypto";
import type { RuntimeTurnPrompt, RuntimeTurnPromptOutcome } from "@vetta/runtime-core";
import type { CodexHostSessionCatalog } from "./host-catalog.js";
import { CODEX_HOST_CAPABILITIES, type CodexHostAssembly, type CodexHostEvent, type CodexSessionRecord } from "./host-contracts.js";
import { CodexHostProjection } from "./host-projection.js";
import { deferred, safeNotify } from "./protocol.js";
import type { CodexAppServerSession } from "./session.js";
import { CodexRuntimeError, type CodexSessionEvent, type CodexTurn } from "./types.js";

interface Operation {
	readonly controller: AbortController;
	readonly result: ReturnType<typeof deferred<RuntimeTurnPromptOutcome>>;
	readonly released: ReturnType<typeof deferred<void>>;
	terminalEvents: CodexHostEvent[];
	terminal?: CodexTurn;
	projectionFailure?: unknown;
	stop?: Promise<void>;
}

/** Converts a Codex-owned session into the existing RuntimeHost ports; never executes a Native turn. */
export class CodexHostSession {
	readonly assembly: CodexHostAssembly;
	private readonly projection: CodexHostProjection;
	private readonly listeners = new Set<(event: CodexHostEvent) => void>();
	private readonly eventQueue: CodexHostEvent[] = [];
	private publishing = false;
	private operation?: Operation;
	private disposed = false;
	private recovery = false;
	private stopEpoch = 0;
	private closing?: Promise<void>;
	private metadataTail: Promise<void> = Promise.resolve();
	private readonly unsubscribe: () => void;

	constructor(private readonly remote: CodexAppServerSession, private record: CodexSessionRecord,
		private readonly path: string, private readonly catalog: CodexHostSessionCatalog,
		private readonly releaseOwnership: () => Promise<void>) {
		this.projection = new CodexHostProjection(record.sessionId, record.threadId);
		this.projection.replaceHistory(remote.readThread());
		this.unsubscribe = remote.subscribe((event) => this.observe(event));
		const unsupported = (operation: string): never => {
			throw new CodexRuntimeError("UNSUPPORTED", `Codex backend does not support ${operation}`);
		};
		this.assembly = {
			codexCapabilities: CODEX_HOST_CAPABILITIES,
			lifecycle: { sessionId: record.sessionId, sessionPath: path, dispose: () => this.close() },
			workspaceView: { readWorkingDirectory: () => this.record.cwd },
			historyReader: { readHistory: () => this.projection.readHistory() },
			historyController: {
				navigateForEdit: async () => unsupported("history editing"), switchBranch: async () => unsupported("branch switching"),
				appendBranchSummary: async () => unsupported("branch summaries"), deleteMessage: async () => unsupported("message deletion"),
				replaceLastUserMessage: async () => unsupported("message replacement"), forkSession: async () => unsupported("forking"),
				setName: (name) => this.rename(name),
			},
			executionController: {
				isBusy: () => this.busy() || this.recovery,
				reconfigure: (update) => {
					this.assertOpen();
					if (update.sessionId !== this.record.sessionId || update.mode !== "sandbox") unsupported("execution permission changes");
				},
			},
			configurationController: { setSteeringMode: () => unsupported("Native steering queues"),
				setFollowUpMode: () => unsupported("Native follow-up queues") },
			modelController: { selectModel: async () => unsupported("Native model selection"),
				setThinkingLevel: () => unsupported("Native reasoning selection"), refreshAuth: async () => unsupported("credential sharing") },
			modelView: { readCurrentModel: () => undefined, readAvailableModels: () => [],
				refreshAvailableModels: () => unsupported("Native model discovery"), resolveApiKey: async () => unsupported("credential access") },
			corePorts: {
				turnControl: {
					prompt: (request) => this.prompt(request), promptWhenAvailable: (request, signal) => this.whenAvailable(request, signal),
					queuePromptIfRunning: async (request) => {
						this.validatePrompt(request); this.assertOpen();
						if (this.busy()) unsupported("Native queue admission; use explicit Codex steering");
						return { status: "idle" };
					},
					continue: async () => unsupported("implicit continuation"), retry: async () => unsupported("automatic turn replay"),
					abort: () => this.abort(),
				},
				eventStream: { subscribe: (listener) => {
					this.assertOpen(); this.listeners.add(listener); return () => this.listeners.delete(listener);
				} },
				stateReader: { readMessages: () => this.projection.readMessages(), readState: () => ({
					// Native model/reasoning controls are disabled, not a report of Codex's internal model effort.
					model: undefined, thinkingLevel: "off", isStreaming: this.busy(),
					messageCount: this.projection.readMessages().length, activeToolNames: [],
					contextPercent: null, contextTokens: null, contextWindow: 0,
				}) },
			},
		};
	}

	readSnapshot() {
		return { sessionId: this.record.sessionId, threadId: this.record.threadId, profileId: this.record.profileId,
			state: this.disposed ? "closed" : this.recovery ? "recovery-required" : this.operation?.controller.signal.aborted ? "cancelling" : this.busy() ? "running" : "idle",
			executingToolNames: this.projection.readActiveTools(),
			cursor: this.projection.readCursor(), history: this.projection.readHistory(), capabilities: CODEX_HOST_CAPABILITIES };
	}

	async prompt(request: RuntimeTurnPrompt): Promise<RuntimeTurnPromptOutcome> {
		this.validatePrompt(request);
		this.assertOpen();
		if (this.busy()) {
			if (request.streamingBehavior !== "steer") throw new CodexRuntimeError("BUSY", "Codex session is already running");
			const turnId = this.remote.readState().turnId;
			if (!turnId) throw new CodexRuntimeError("BUSY", "Codex has not acknowledged the active turn yet");
			await this.remote.steer({ text: request.text, expectedTurnId: turnId, inputId: randomUUID() });
			return { status: "handled", turnId };
		}
		const op: Operation = { controller: new AbortController(), result: deferred<RuntimeTurnPromptOutcome>(),
			released: deferred<void>(), terminalEvents: [] };
		this.operation = op;
		// Publish ownership before an async method can call observers or dispatch to Codex.
		void this.execute(op, request).then(op.result.resolve, op.result.reject);
		return op.result.promise;
	}

	async whenAvailable(request: RuntimeTurnPrompt, signal?: AbortSignal): Promise<RuntimeTurnPromptOutcome> {
		this.validatePrompt(request);
		const epoch = this.stopEpoch;
		while (true) {
			signal?.throwIfAborted(); this.assertOpen();
			if (epoch !== this.stopEpoch) throw new CodexRuntimeError("CANCELLED", "Waiting prompt was cancelled by stop");
			const active = this.operation;
			if (!active) break;
			await abortable(active.released.promise, signal);
		}
		const result = this.prompt(request);
		const admitted = this.operation;
		const abort = () => { if (this.operation === admitted) void this.abort().catch(() => undefined); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try { return await result; } finally { signal?.removeEventListener("abort", abort); }
	}

	abort(): Promise<void> {
		this.stopEpoch += 1;
		const op = this.operation;
		if (!op || op.terminal) return op?.released.promise ?? Promise.resolve();
		op.controller.abort();
		op.stop ??= this.remote.interrupt();
		return Promise.all([op.stop, op.released.promise]).then(() => undefined);
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.disposed = true;
		this.stopEpoch += 1;
		const op = this.operation;
		op?.controller.abort();
		this.closing = (async () => {
			// Do not release the lease unless the owned remote process really closes.
			await this.remote.close();
			await op?.released.promise;
			await this.metadataTail;
			this.unsubscribe(); this.listeners.clear();
			await this.releaseOwnership();
		})();
		return this.closing;
	}

	private async execute(op: Operation, request: RuntimeTurnPrompt): Promise<RuntimeTurnPromptOutcome> {
		let failure: unknown;
		try {
			op.controller.signal.throwIfAborted();
			const run = await this.remote.startTurn({ text: request.text, inputId: randomUUID() });
			op.terminal = await run.completed;
			if (this.recovery) throw new CodexRuntimeError("RECOVERY_REQUIRED", "Codex projection requires reconciliation");
			if (!this.disposed) {
				// Fetch authority, not an event replay: sparse turn/completed payloads may omit items.
				this.projection.replaceHistory(await this.remote.refreshHistory());
				await this.updatePreviews();
			}
			return { status: op.terminal.status === "completed" ? "completed" : op.terminal.status === "interrupted" ? "cancelled" : "failed",
				turnId: run.turnId, ...(op.terminal.status === "failed" ? { error: {
					code: "CODEX_TURN_FAILED", message: errorMessage(op.terminal.error), retryable: false, origin: "runtime" as const,
				} } : {}) };
		} catch (error) {
			failure = error;
			if (!(error instanceof CodexRuntimeError && (error.code === "REMOTE" || error.code === "CANCELLED"))) this.recovery = !this.disposed;
			return { status: error instanceof CodexRuntimeError && error.code === "CANCELLED" ? "cancelled" : "failed",
				...(op.terminal ? { turnId: op.terminal.id } : {}), error: {
					code: error instanceof CodexRuntimeError ? error.code : "CODEX_OUTCOME_UNKNOWN",
					message: errorMessage(error), retryable: false, origin: "runtime",
				} };
		} finally {
			if (this.operation === op) this.operation = undefined;
			op.released.resolve();
			if (!this.disposed) this.publish(failure ? this.projection.failure(op.projectionFailure ?? failure) : op.terminalEvents);
		}
	}

	private observe(event: CodexSessionEvent): void {
		if (this.disposed) return;
		try {
			if (event.method === "runtime/state" && event.params.state === "recovery-required") this.recovery = true;
			const events = this.projection.accept(event);
			if (event.method === "turn/completed" && this.operation) this.operation.terminalEvents.push(...events);
			else this.publish(events);
		} catch (error) {
			this.recovery = true;
			if (this.operation) this.operation.projectionFailure = error;
			else this.publish(this.projection.failure(error));
			void this.remote.close().catch(() => undefined);
		}
	}

	private rename(name: string): Promise<void> {
		this.assertOpen();
		const validated = this.catalog.validateName(name);
		return this.writeMetadata(async () => { this.record = await this.catalog.update(this.path, { name: validated }); });
	}

	private updatePreviews(): Promise<void> {
		const messages = this.projection.readMessages().filter((message) => message.role === "user" || message.role === "assistant");
		const texts = messages.map((message) => typeof message.content === "string" ? message.content :
			message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")).filter(Boolean);
		return this.writeMetadata(async () => { this.record = await this.catalog.update(this.path, {
			firstMessage: texts[0]?.slice(0, 120) ?? this.record.firstMessage,
			lastMessagePreview: texts.at(-1)?.slice(0, 120) ?? this.record.lastMessagePreview,
		}); });
	}

	private writeMetadata(write: () => Promise<void>): Promise<void> {
		const job = this.metadataTail.then(write);
		this.metadataTail = job.catch(() => undefined);
		return job;
	}

	private validatePrompt(request: RuntimeTurnPrompt): void {
		if (!request.text.trim()) throw new CodexRuntimeError("INPUT", "A non-empty text prompt is required");
		if (request.attachments?.length || request.images?.length || request.context?.length || request.promptRef ||
			request.modelKey !== undefined || request.reasoning !== undefined || request.metadata !== undefined ||
			(request.streamingBehavior !== undefined && request.streamingBehavior !== "steer")) {
			throw new CodexRuntimeError("UNSUPPORTED", "Codex currently accepts text and explicit steering only; Native options are not forwarded");
		}
	}

	private assertOpen(): void {
		if (this.disposed) throw new CodexRuntimeError("CLOSED", "Codex host session is closed");
		if (this.recovery || this.remote.readState().state === "recovery-required") throw new CodexRuntimeError("RECOVERY_REQUIRED", "Reopen and reconcile the Codex thread before sending more work");
	}

	private busy(): boolean { return this.operation !== undefined; }
	private publish(events: readonly CodexHostEvent[]): void {
		this.eventQueue.push(...events);
		if (this.publishing) return;
		this.publishing = true;
		try { while (this.eventQueue.length) { const event = this.eventQueue.shift(); if (event) safeNotify(this.listeners, event); } }
		finally { this.publishing = false; }
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return "Codex execution outcome is unavailable; inspect the saved thread before retrying";
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
