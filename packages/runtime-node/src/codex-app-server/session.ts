import { randomUUID } from "node:crypto";
import { deferred, object, positive, readThread, readTurn, safeNotify, text } from "./protocol.js";
import type { CodexRpcConnection } from "./rpc.js";
import { CodexRuntimeError, type CodexSessionEvent, type CodexSessionOptions, type CodexSessionState, type CodexThread, type CodexTurn, type CodexTurnHandle, type JsonObject, type ServerRequest, } from "./types.js";
interface ActiveTurn {
	id?: string;
	readonly completion: ReturnType<typeof deferred<CodexTurn>>;
	readonly ready: ReturnType<typeof deferred<void>>;
	readonly approvalSignal: AbortController;
	readonly buffered: Array<{
		method: string;
		params: JsonObject;
	}>;
	bufferBytes: number;
	readonly deadline: ReturnType<typeof setTimeout>;
	cancelRequested: boolean;
	done: boolean;
	terminal?: CodexTurn;
	interrupting?: Promise<void>;
}
/** A protocol adapter, not another agent loop. This object owns one Codex connection/thread. */
export class CodexAppServerSession {
	private readonly instanceId = randomUUID();
	private sequence = 0;
	private delivering = false;
	private readonly eventQueue: CodexSessionEvent[] = [];
	private turnGeneration = 0;
	private state: CodexSessionState = "idle";
	private active?: ActiveTurn;
	private readonly listeners = new Set<(event: CodexSessionEvent) => void>();
	private readonly unsubscribe: () => void;
	private readonly unsubscribeFailure: () => void;
	private readonly interruptTimeout: number;
	private readonly turnTimeout: number;
	private closing?: Promise<void>;
	constructor(private readonly rpc: CodexRpcConnection, private thread: CodexThread, private readonly options: CodexSessionOptions = {}) {
		this.interruptTimeout = positive(options.interruptTimeoutMs, 10000);
		this.turnTimeout = positive(options.turnTimeoutMs, 30 * 60000);
		if (thread.turns.some((turn) => turn.status === "inProgress")) {
			throw new CodexRuntimeError("RECOVERY_REQUIRED", "Resumed thread has an active turn; reconcile before starting work");
		}
		this.unsubscribe = rpc.subscribe((event) => this.receive(event));
		this.unsubscribeFailure = rpc.onFailure(() => this.fault(new CodexRuntimeError("OUTCOME_UNKNOWN", "Codex connection ended; reconcile the saved thread before retrying")));
	}
	get threadId(): string { return this.thread.id; }
	readState(): {
		state: CodexSessionState;
		turnId?: string;
	} {
		return { state: this.state, ...(this.active?.id ? { turnId: this.active.id } : {}) };
	}
	readThread(): CodexThread { return structuredClone(this.thread); }
	subscribe(listener: (event: CodexSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async startTurn(input: {
		text: string;
		inputId?: string;
	}): Promise<CodexTurnHandle> {
		this.assertIdle();
		if (!input.text.trim())
			throw new CodexRuntimeError("INPUT", "A non-empty prompt is required");
		const run: ActiveTurn = {
			completion: deferred<CodexTurn>(), ready: deferred<void>(), approvalSignal: new AbortController(),
			buffered: [], bufferBytes: 0, cancelRequested: false, done: false,
			deadline: setTimeout(() => {
				if (this.active === run)
					void this.interrupt(run.id).catch(() => undefined);
			}, this.turnTimeout),
		};
		this.active = run;
		this.turnGeneration += 1;
		this.setState("starting");
		try {
			if (this.active !== run || run.done || run.cancelRequested) {
				throw new CodexRuntimeError("CANCELLED", "Turn cancelled before dispatch");
			}
			const response = object(await this.rpc.request("turn/start", {
				threadId: this.thread.id, clientUserMessageId: input.inputId ?? randomUUID(),
				input: [{ type: "text", text: input.text, text_elements: [] }],
			}));
			const turn = readTurn(response.turn);
			if (this.active !== run || run.done)
				throw new CodexRuntimeError("OUTCOME_UNKNOWN", "Turn admission was interrupted");
			run.id = turn.id;
			run.ready.resolve();
			this.setState(run.cancelRequested ? "cancelling" : "running");
			// Notifications may precede the RPC response. Bind the returned turn ID before replaying them.
			for (const event of run.buffered.splice(0))
				this.receiveBound(run, event);
			run.bufferBytes = 0;
			return { turnId: turn.id, completed: run.completion.promise };
		}
		catch (error) {
			if (this.active === run) {
				if (error instanceof CodexRuntimeError && (error.code === "REMOTE" || error.code === "CANCELLED")) {
					this.finishRejected(run, error);
				}
				else
					this.fault(error instanceof Error ? error : new CodexRuntimeError("PROTOCOL", "Invalid turn admission"));
			}
			throw error;
		}
	}
	async steer(input: {
		text: string;
		expectedTurnId: string;
		inputId?: string;
	}): Promise<void> {
		const run = this.active;
		if (this.state !== "running" || !run?.id || run.id !== input.expectedTurnId) {
			throw new CodexRuntimeError("TURN_MISMATCH", "Steering target is not the active turn");
		}
		if (!input.text.trim())
			throw new CodexRuntimeError("INPUT", "A non-empty steering message is required");
		await this.rpc.request("turn/steer", {
			threadId: this.thread.id, expectedTurnId: run.id, clientUserMessageId: input.inputId ?? randomUUID(),
			input: [{ type: "text", text: input.text, text_elements: [] }],
		});
	}
	interrupt(expectedTurnId?: string): Promise<void> {
		const run = this.active;
		if (expectedTurnId !== undefined && run?.id !== expectedTurnId) {
			return Promise.reject(new CodexRuntimeError("TURN_MISMATCH", "Stop target is not the active turn"));
		}
		if (!run)
			return Promise.resolve();
		if (run.interrupting)
			return run.interrupting;
		run.cancelRequested = true;
		// Publish the shared stop promise before invoking any host callbacks.
		run.interrupting = Promise.resolve().then(() => this.stop(run));
		this.state = "cancelling";
		run.approvalSignal.abort();
		if (this.active === run && this.readState().state === "cancelling") {
			this.publish("runtime/state", { state: "cancelling", ...(run.id ? { turnId: run.id } : {}) });
		}
		return run.interrupting;
	}
	async refreshHistory(): Promise<CodexThread> {
		this.assertIdle();
		const generation = this.turnGeneration;
		const response = object(await this.rpc.request("thread/read", { threadId: this.thread.id, includeTurns: true }));
		if (this.state !== "idle" || this.turnGeneration !== generation)
			return this.readThread();
		const thread = readThread(response.thread);
		if (thread.id !== this.thread.id || thread.turns.some((turn) => turn.status === "inProgress")) {
			const error = new CodexRuntimeError("RECOVERY_REQUIRED", "Thread history disagrees with the local idle state");
			this.fault(error);
			throw error;
		}
		// A new turn may have been admitted while the history request was in flight.
		if (this.state === "idle" && this.turnGeneration === generation)
			this.thread = thread;
		return this.readThread();
	}
	async handleServerRequest(request: ServerRequest): Promise<unknown> {
		if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") {
			throw new CodexRuntimeError("UNSUPPORTED", "Host capability is not implemented", request.method, -32601);
		}
		const run = this.active;
		if (!run || request.params.threadId !== this.thread.id || run.cancelRequested || request.signal.aborted)
			return { decision: "cancel" };
		await run.ready.promise;
		const matches = () => this.active === run && !run.done && !run.cancelRequested && !request.signal.aborted &&
			request.params.turnId === run.id && typeof request.params.itemId === "string";
		if (!matches())
			return { decision: "cancel" };
		if (!this.options.onApproval)
			return { decision: "decline" };
		const controller = new AbortController();
		const abort = () => controller.abort();
		request.signal.addEventListener("abort", abort, { once: true });
		run.approvalSignal.signal.addEventListener("abort", abort, { once: true });
		try {
			if (!matches())
				return { decision: "cancel" };
			const decision = await this.options.onApproval({ ...request, params: structuredClone(request.params), signal: controller.signal });
			if (!matches() || controller.signal.aborted)
				return { decision: "cancel" };
			if (decision !== "accept" && decision !== "decline" && decision !== "cancel")
				return { decision: "decline" };
			const available = request.params.availableDecisions;
			if (Array.isArray(available) && !available.includes(decision))
				return { decision: "cancel" };
			return { decision };
		}
		finally {
			request.signal.removeEventListener("abort", abort);
			run.approvalSignal.signal.removeEventListener("abort", abort);
		}
	}
	close(): Promise<void> {
		if (this.closing)
			return this.closing;
		this.closing = Promise.resolve().then(() => this.rpc.close());
		this.setState("closed");
		const run = this.active;
		if (run)
			this.rejectRun(run, new CodexRuntimeError("CLOSED", "Session closed; unfinished effects may need reconciliation"));
		this.active = undefined;
		this.unsubscribe();
		this.unsubscribeFailure();
		return this.closing;
	}
	private async stop(run: ActiveTurn): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					await run.ready.promise;
					if (run.done) {
						await run.completion.promise;
						return;
					}
					await this.rpc.request("turn/interrupt", { threadId: this.thread.id, turnId: run.id });
					await run.completion.promise;
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new CodexRuntimeError("OUTCOME_UNKNOWN", "Stop was not confirmed by a terminal event")), this.interruptTimeout);
				}),
			]);
		}
		catch (error) {
			if (run.terminal)
				return;
			if (!run.done)
				this.fault(error instanceof Error ? error : new CodexRuntimeError("OUTCOME_UNKNOWN", "Stop failed"));
			throw error;
		}
		finally {
			if (timer)
				clearTimeout(timer);
		}
	}
	private receive(event: {
		method: string;
		params: JsonObject;
	}): void {
		if (this.state === "closed" || this.state === "recovery-required" || event.params.threadId !== this.thread.id)
			return;
		const run = this.active;
		if (!run)
			return;
		if (!run.id) {
			run.bufferBytes += Buffer.byteLength(JSON.stringify(event));
			if (run.buffered.length >= 256 || run.bufferBytes > 8 * 1024 * 1024) {
				this.fault(new CodexRuntimeError("LIMIT", "Too many events before turn admission"));
				return;
			}
			run.buffered.push(event);
			return;
		}
		this.receiveBound(run, event);
	}
	private receiveBound(run: ActiveTurn, event: {
		method: string;
		params: JsonObject;
	}): void {
		if (this.active !== run || run.done)
			return;
		try {
			const turnId = event.method === "turn/started" || event.method === "turn/completed"
				? text(object(event.params.turn).id, "turn.id") : event.params.turnId;
			if (turnId !== run.id)
				return;
			if (event.method === "turn/completed") {
				const turn = readTurn(event.params.turn);
				if (turn.status === "inProgress")
					throw new Error("Nonterminal turn/completed");
				run.done = true;
				run.terminal = turn;
				clearTimeout(run.deadline);
				this.thread = { ...this.thread, turns: [...this.thread.turns.filter((entry) => entry.id !== turn.id), { ...turn }] };
				this.active = undefined;
				this.state = "idle";
				run.completion.resolve(structuredClone(turn));
				run.approvalSignal.abort();
				if (this.readState().state !== "closed")
					this.publish(event.method, event.params);
				if (!this.active && this.readState().state === "idle")
					this.publish("runtime/state", { state: "idle" });
				return;
			}
			// Late streaming/tool deltas do not resurrect a cancelling UI, but final items remain observable.
			if (run.cancelRequested && event.method !== "item/completed" && event.method !== "error")
				return;
			this.publish(event.method, event.params);
		}
		catch {
			this.fault(new CodexRuntimeError("PROTOCOL", "Invalid Codex turn event"));
		}
	}
	private finishRejected(run: ActiveTurn, error: Error): void {
		this.active = undefined;
		this.state = "idle";
		this.rejectRun(run, error);
		if (!this.active && this.readState().state === "idle")
			this.publish("runtime/state", { state: "idle" });
	}
	private rejectRun(run: ActiveTurn, error: Error): void {
		run.done = true;
		clearTimeout(run.deadline);
		run.buffered.length = 0;
		run.ready.reject(error);
		run.completion.reject(error);
		run.approvalSignal.abort();
	}
	private fault(error: Error): void {
		if (this.state === "closed" || this.state === "recovery-required")
			return;
		const run = this.active;
		this.active = undefined;
		this.state = "recovery-required";
		if (run)
			this.rejectRun(run, error);
		if (this.readState().state === "recovery-required")
			this.publish("runtime/state", { state: "recovery-required" });
		void this.rpc.close().catch(() => undefined);
	}
	private assertIdle(): void {
		if (this.state !== "idle")
			throw new CodexRuntimeError(this.state === "closed" ? "CLOSED" :
				this.state === "recovery-required" ? "RECOVERY_REQUIRED" : "BUSY", "Codex session is not idle");
	}
	private setState(state: CodexSessionState): void {
		this.state = state;
		this.publish("runtime/state", { state, ...(this.active?.id ? { turnId: this.active.id } : {}) });
	}
	private publish(method: string, params: JsonObject): void {
		this.eventQueue.push({ instanceId: this.instanceId, sequence: ++this.sequence, threadId: this.thread.id, method, params });
		if (this.delivering)
			return;
		this.delivering = true;
		try {
			let event = this.eventQueue.shift();
			while (event) {
				safeNotify(this.listeners, event);
				event = this.eventQueue.shift();
			}
		}
		finally {
			this.delivering = false;
		}
	}
}
