import { createHash, randomUUID } from "node:crypto";
import type {
	CodexModelChoice,
	CodexRuntimeDefaults,
	CodexWorkspaceCommand,
	CodexWorkspaceProfile,
	CodexWorkspaceReply,
	CodexWorkspaceSnapshot,
} from "../../shared/codex-workspace.js";
import { CodexWorkspaceApprovals, type WorkspaceApprovalRequest } from "./approvals.js";
import { CodexWorkspaceError, command, errorCode, identifier } from "./validation.js";

export interface WorkspaceSession {
	id: string;
	snapshot(): Pick<CodexWorkspaceSnapshot, "rows" | "hasEarlierRows"> & { recovery: boolean };
	subscribe(listener: () => void): () => void;
	prompt(text: string): Promise<{ status: "completed" | "cancelled" | "failed"; errorCode?: string }>;
	stop(): Promise<void>;
	close(): Promise<void>;
}
export interface WorkspaceBackend {
	list(): Promise<CodexWorkspaceSnapshot["sessions"]>;
	open(sessionId?: string): Promise<WorkspaceSession>;
	close(): Promise<void>;
}
export interface CodexWorkspaceControllerOptions {
	readProfile(): Promise<CodexWorkspaceProfile | undefined>;
	readRuntimeDefaults?(): Promise<CodexRuntimeDefaults | undefined>;
	listModels?(): Promise<CodexModelChoice[]>;
	writeProfile(profile: CodexWorkspaceProfile): Promise<void>;
	confirmProfile(profile: CodexWorkspaceProfile): Promise<boolean>;
	choosePath(field: "executable" | "codexHome" | "cwd"): Promise<string | undefined>;
	createBackend(
		profile: CodexWorkspaceProfile,
		approval: (request: WorkspaceApprovalRequest) => Promise<"accept" | "decline" | "cancel">,
	): WorkspaceBackend;
}
interface ActiveSession {
	handle: WorkspaceSession;
	unsubscribe(): void;
	task?: Promise<void>;
	inputId?: string;
	closing: boolean;
}

/** One main-window owner. All long work is admitted here, never in an IPC handler or React callback. */
export class CodexWorkspaceController {
	private readonly instanceId = randomUUID();
	private revision = 0;
	private phase: CodexWorkspaceSnapshot["phase"] = "setup";
	private profile?: CodexWorkspaceProfile;
	private runtimeDefaults?: CodexRuntimeDefaults;
	private token?: string;
	private backend?: WorkspaceBackend;
	private active?: ActiveSession;
	private sessions: CodexWorkspaceSnapshot["sessions"] = [];
	private error?: string;
	private outcome?: CodexWorkspaceSnapshot["outcome"];
	private disposed = false;
	private generation = 0;
	private exclusive?: Promise<void>;
	private closing?: Promise<void>;
	private configuring = false;
	private attachVersion = 0;
	private sessionClosing?: Promise<void>;
	private readonly inputs = new Map<string, { sessionId: string; digest: string }>();
	private readonly listeners = new Set<(notice: { instanceId: string; revision: number }) => void>();
	private readonly approvals = new CodexWorkspaceApprovals(() => this.changed());
	private readonly ready: Promise<void>;
	constructor(private readonly options: CodexWorkspaceControllerOptions) {
		this.ready = this.readInitialConfiguration();
	}
	subscribe(listener: (notice: { instanceId: string; revision: number }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async attach(): Promise<{ token: string; snapshot: CodexWorkspaceSnapshot }> {
		const version = ++this.attachVersion;
		await this.ready;
		this.assertAlive();
		if (version !== this.attachVersion) throw new CodexWorkspaceError("VIEW_EXPIRED");
		this.approvals.cancelAll();
		const token = randomUUID();
		this.token = token;
		if (this.profile && !this.configuring && !this.sessionClosing) {
			try {
				const backend = this.ensureBackend();
				const sessions = await backend.list();
				if (this.backend === backend && !this.configuring) this.sessions = sessions;
			} catch (error) {
				if (version === this.attachVersion) this.error = errorCode(error);
			}
		}
		this.assertToken(token);
		this.changed();
		return { token, snapshot: this.snapshot() };
	}
	async execute(token: unknown, value: unknown): Promise<CodexWorkspaceReply> {
		try {
			await this.ready;
			this.assertToken(token);
			const action = command(value);
			if (action.type === "detach") {
				this.token = undefined;
				this.approvals.cancelAll();
				if (this.phase === "opening") void this.closeSession().catch(() => undefined);
				return { ok: true };
			}
			if (action.type === "models") {
				const models = (await this.options.listModels?.()) ?? [];
				this.assertToken(token);
				return { ok: true, models };
			}
			if (action.type === "snapshot") return { ok: true, snapshot: this.snapshot() };
			if (action.type === "choose") {
				const chosenPath = await this.options.choosePath(action.field);
				this.assertToken(token);
				return { ok: true, ...(chosenPath ? { chosenPath } : {}) };
			}
			if (action.type === "configure") {
				await this.configure(token, action.profile);
				return { ok: true, snapshot: this.snapshot() };
			}
			if (action.type === "open") {
				await this.open(token, action.sessionId);
				return { ok: true, snapshot: this.snapshot() };
			}
			if (action.type === "send") {
				this.send(action);
				return { ok: true, acceptedInputId: action.inputId, snapshot: this.snapshot() };
			}
			if (action.type === "stop") {
				const active = this.requireSession(action.sessionId);
				if (active.inputId !== action.inputId) throw new CodexWorkspaceError("TURN_MISMATCH");
				this.phase = "stopping";
				this.approvals.cancelAll();
				this.changed();
				await active.handle.stop();
				await active.task;
				return { ok: true, snapshot: this.snapshot() };
			}
			if (action.type === "approval") {
				this.approvals.decide(action.approvalId, action.decision, this.active?.handle.id, this.active?.inputId);
				return { ok: true, snapshot: this.snapshot() };
			}
			await this.closeSession();
			return { ok: true, snapshot: this.snapshot() };
		} catch (error) {
			// IPC must not serialize provider errors, auth paths or request bodies into application logs.
			return { ok: false, code: errorCode(error) };
		}
	}
	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.disposed = true;
		this.token = undefined;
		this.generation += 1;
		this.approvals.cancelAll();
		this.phase = "closed";
		this.changed();
		this.closing = Promise.resolve().then(async () => {
			await this.ready;
			await this.exclusive?.catch(() => undefined);
			await this.sessionClosing?.catch(() => undefined);
			await this.active?.handle.close();
			await this.active?.task;
			this.active?.unsubscribe();
			this.active = undefined;
			await this.backend?.close();
			this.backend = undefined;
			this.listeners.clear();
		});
		return this.closing;
	}
	private async readInitialConfiguration(): Promise<void> {
		try {
			const profile = await this.options.readProfile();
			if (this.disposed) return;
			this.profile = profile;
			this.phase = profile ? "ready" : "setup";
		} catch {
			if (!this.disposed) this.error = "CONFIGURATION";
		}
		try {
			const defaults = await this.options.readRuntimeDefaults?.();
			if (this.disposed) return;
			this.runtimeDefaults = defaults;
		} catch (error) {
			if (!this.disposed) this.error = errorCode(error);
		}
		if (!this.disposed) this.changed();
	}
	private snapshot(): CodexWorkspaceSnapshot {
		const history = this.active?.handle.snapshot();
		return {
			instanceId: this.instanceId,
			revision: this.revision,
			phase: this.phase,
			...(this.profile ? { profile: { ...this.profile } } : {}),
			...(this.runtimeDefaults ? { runtimeDefaults: { ...this.runtimeDefaults } } : {}),
			...(this.active ? { sessionId: this.active.handle.id } : {}),
			...(this.active?.inputId ? { activeInputId: this.active.inputId } : {}),
			rows: structuredClone(history?.rows ?? []),
			hasEarlierRows: history?.hasEarlierRows ?? false,
			approvals: this.approvals.list(),
			sessions: structuredClone(this.sessions),
			...(this.error ? { errorCode: this.error } : {}),
			...(this.outcome ? { outcome: this.outcome } : {}),
		};
	}
	private async configure(token: unknown, profile: CodexWorkspaceProfile): Promise<void> {
		if (this.active || this.exclusive || this.configuring || this.sessionClosing)
			throw new CodexWorkspaceError("BUSY");
		this.configuring = true;
		try {
			if (profile.vettaModelKey) {
				const model = ((await this.options.listModels?.()) ?? []).find(
					(item) => item.modelKey === profile.vettaModelKey,
				);
				if (!model || model.unavailable)
					throw new CodexWorkspaceError(model?.unavailable ?? "MODEL_REFERENCE_MISSING");
				this.assertToken(token);
			}
			if (!(await this.options.confirmProfile(profile))) throw new CodexWorkspaceError("CANCELLED");
			this.assertToken(token);
			await this.backend?.close();
			this.backend = undefined;
			this.assertToken(token);
			await this.options.writeProfile(profile);
			// Once persisted, this is authoritative even if the originating view has gone away.
			this.profile = profile;
			this.sessions = [];
			this.error = undefined;
			if (!this.disposed) {
				this.phase = "ready";
				this.changed();
			}
			this.assertToken(token);
			this.sessions = await this.ensureBackend().list();
			this.assertToken(token);
			this.changed();
		} finally {
			this.configuring = false;
		}
	}
	private async open(token: unknown, sessionId?: string): Promise<void> {
		if (this.active || this.exclusive || this.configuring || this.sessionClosing)
			throw new CodexWorkspaceError("BUSY");
		if (!this.profile) throw new CodexWorkspaceError("CONFIGURATION");
		const generation = ++this.generation;
		this.phase = "opening";
		this.error = undefined;
		this.outcome = undefined;
		this.changed();
		const work = Promise.resolve().then(async () => {
			let handle: WorkspaceSession | undefined;
			try {
				this.assertToken(token);
				const backend = this.ensureBackend();
				handle = await backend.open(sessionId);
				if (this.disposed || generation !== this.generation || token !== this.token) {
					await handle.close();
					handle = undefined;
					throw new CodexWorkspaceError("CANCELLED");
				}
				const active: ActiveSession = { handle, closing: false, unsubscribe: () => {} };
				active.unsubscribe = handle.subscribe(() => {
					if (this.active !== active || active.closing || this.disposed) return;
					if (active.handle.snapshot().recovery) this.phase = "recovery";
					this.changed();
				});
				this.active = active;
				this.sessions = await backend.list();
				if (this.disposed || generation !== this.generation || token !== this.token)
					throw new CodexWorkspaceError("CANCELLED");
				if (!this.disposed && generation === this.generation) {
					this.phase = "ready";
					this.changed();
				}
			} catch (error) {
				if (handle && (this.disposed || generation !== this.generation || token !== this.token || !this.active)) {
					await handle.close();
					if (this.active?.handle === handle) {
						this.active.unsubscribe();
						this.active = undefined;
					}
				}
				if (!this.disposed && generation === this.generation) {
					this.error = errorCode(error);
					this.phase = this.active ? "recovery" : "ready";
					this.changed();
				}
				throw error;
			}
		});
		this.exclusive = work;
		try {
			await work;
		} finally {
			if (this.exclusive === work) this.exclusive = undefined;
		}
	}
	private send(action: Extract<CodexWorkspaceCommand, { type: "send" }>): void {
		const active = this.requireSession(action.sessionId);
		const digest = createHash("sha256").update(action.text).digest("hex");
		const prior = this.inputs.get(action.inputId);
		if (prior) {
			if (prior.sessionId !== action.sessionId || prior.digest !== digest)
				throw new CodexWorkspaceError("INPUT_CONFLICT");
			return;
		}
		if (this.phase !== "ready" || active.task || active.handle.snapshot().recovery)
			throw new CodexWorkspaceError("BUSY");
		active.inputId = action.inputId;
		this.phase = "running";
		this.error = undefined;
		this.outcome = undefined;
		this.inputs.set(action.inputId, { sessionId: action.sessionId, digest });
		if (this.inputs.size > 128) this.inputs.delete(this.inputs.keys().next().value!);
		// Publish the task before notifying observers; stop/close may re-enter through a native event callback.
		active.task = Promise.resolve()
			.then(async () => {
				if (this.disposed || active.closing || this.phase === "stopping" || this.phase === "closing")
					return { status: "cancelled" as const };
				return active.handle.prompt(action.text);
			})
			.then(
				(result) => {
					if (this.active !== active || active.closing || this.disposed) return;
					this.outcome = result.status;
					this.error = result.errorCode;
					this.phase = active.handle.snapshot().recovery ? "recovery" : "ready";
				},
				(error) => {
					if (this.active !== active || active.closing || this.disposed) return;
					this.error = errorCode(error);
					this.outcome = "failed";
					this.phase = "recovery";
				},
			)
			.finally(() => {
				active.inputId = undefined;
				active.task = undefined;
				if (this.active === active) {
					this.approvals.cancelAll();
					this.changed();
				}
			});
		this.changed();
	}
	private closeSession(): Promise<void> {
		if (this.sessionClosing) return this.sessionClosing;
		const closing = this.doCloseSession();
		this.sessionClosing = closing;
		void closing.then(
			() => {
				if (this.sessionClosing === closing) this.sessionClosing = undefined;
			},
			() => {
				if (this.sessionClosing === closing) this.sessionClosing = undefined;
			},
		);
		return closing;
	}
	private async doCloseSession(): Promise<void> {
		if (this.configuring) throw new CodexWorkspaceError("BUSY");
		this.generation += 1;
		this.phase = "closing";
		if (this.active) this.active.closing = true;
		this.approvals.cancelAll();
		this.changed();
		try {
			await this.exclusive?.catch(() => undefined);
			const active = this.active;
			if (active) {
				active.closing = true;
				await active.handle.close();
				await active.task;
				active.unsubscribe();
				if (this.active === active) this.active = undefined;
			}
			this.inputs.clear();
			if (this.backend) this.sessions = await this.backend.list();
			if (!this.disposed) {
				this.phase = this.profile ? "ready" : "setup";
				this.error = undefined;
				this.changed();
			}
		} catch (error) {
			if (!this.disposed) {
				this.phase = "recovery";
				this.error = errorCode(error);
				this.changed();
			}
			throw error;
		}
	}
	private ensureBackend(): WorkspaceBackend {
		this.assertAlive();
		if (!this.profile) throw new CodexWorkspaceError("CONFIGURATION");
		this.backend ??= this.options.createBackend(this.profile, (request) => {
			if (!this.token || !this.active?.inputId || this.phase !== "running") return Promise.resolve("decline");
			return this.approvals.request(request, this.active.handle.id, this.active?.inputId);
		});
		return this.backend;
	}
	private requireSession(id: string): ActiveSession {
		this.assertAlive();
		identifier(id);
		if (!this.active || this.active.closing || this.active.handle.id !== id)
			throw new CodexWorkspaceError("SESSION_MISMATCH");
		return this.active;
	}
	private assertAlive(): void {
		if (this.disposed) throw new CodexWorkspaceError("CLOSED");
	}
	private assertToken(token: unknown): asserts token is string {
		this.assertAlive();
		if (typeof token !== "string" || !this.token || token !== this.token)
			throw new CodexWorkspaceError("VIEW_EXPIRED");
	}
	private changed(): void {
		const notice = { instanceId: this.instanceId, revision: ++this.revision };
		for (const listener of [...this.listeners]) {
			try {
				listener(notice);
			} catch {
				/* Observer isolation. */
			}
		}
	}
}
