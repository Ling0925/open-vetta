import type { CodexWorkspaceCommand, CodexWorkspaceReply, CodexWorkspaceSnapshot, DesktopCodexWorkspaceApi } from "../../../shared/codex-workspace.js";

export interface CodexWorkspaceClientState {
	connection: "loading" | "ready" | "failed";
	snapshot?: CodexWorkspaceSnapshot;
	errorCode?: string;
	pending: readonly string[];
}
/** View lifecycle and snapshot ordering; no model execution, raw RPC or permission policy lives here. */
export class CodexWorkspaceClient {
	private state: CodexWorkspaceClientState = { connection: "loading", pending: [] };
	private readonly listeners = new Set<() => void>();
	private readonly pending = new Set<string>();
	private token?: string;
	private alive = true;
	private dirty = false;
	private refreshing = false;
	private scheduled = false;
	private unsubscribe?: () => void;
	private startPromise?: Promise<void>;
	private admissionEpoch = 0;
	constructor(private readonly api: DesktopCodexWorkspaceApi,
		private readonly afterPaint: () => Promise<unknown>, private readonly schedule: (callback: () => void) => void) { }
	read = (): CodexWorkspaceClientState => this.state;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	start(): Promise<void> {
		this.startPromise ??= this.attach(); return this.startPromise;
	}
	async run(command: CodexWorkspaceCommand): Promise<CodexWorkspaceReply> {
		if (!this.alive || !this.token) return { ok: false, code: "VIEW_EXPIRED" };
		if (this.pending.has(command.type)) return { ok: false, code: "BUSY" };
		if (command.type === "close") this.admissionEpoch++;
		const epoch = this.admissionEpoch;
		const token = this.token;
		this.pending.add(command.type); this.update({ errorCode: undefined, pending: [...this.pending] });
		try {
			if (command.type === "open") await this.afterPaint();
			if (!this.alive || this.token !== token) return { ok: false, code: "VIEW_EXPIRED" };
			if (command.type === "open" && epoch !== this.admissionEpoch) return { ok: false, code: "CANCELLED" };
			const reply = await this.api.command(token, command);
			if (this.alive && this.token === token) {
				if (reply.ok) { if (reply.snapshot) this.apply(reply.snapshot); this.invalidate(); }
				else this.update({ errorCode: reply.code });
			}
			return reply;
		} catch {
			if (this.alive) this.update({ errorCode: "CONNECTION_LOST" });
			// The caller must not interpret a transport failure as permission to replay a command.
			return { ok: false, code: "CONNECTION_LOST" };
		} finally {
			this.pending.delete(command.type); if (this.alive) this.update({ pending: [...this.pending] });
		}
	}
	dispose(): void {
		if (!this.alive) return;
		this.alive = false; this.unsubscribe?.(); this.listeners.clear();
		if (this.token) void this.api.command(this.token, { type: "detach" }).catch(() => undefined);
	}
	private async attach(): Promise<void> {
		try {
			await this.afterPaint(); if (!this.alive) return;
			this.unsubscribe = this.api.onChanged(() => this.invalidate());
			const view = await this.api.attach();
			if (!this.alive) { await this.api.command(view.token, { type: "detach" }); return; }
			this.token = view.token; this.apply(view.snapshot); this.update({ connection: "ready", errorCode: undefined });
			// Covers a notice arriving before attach returned its snapshot.
			this.invalidate();
		} catch { if (this.alive) this.update({ connection: "failed", errorCode: "CONNECTION_LOST" }); }
	}
	private invalidate(): void {
		this.dirty = true;
		if (!this.alive || !this.token || this.scheduled || this.refreshing) return;
		this.scheduled = true;
		this.schedule(() => { this.scheduled = false; void this.refresh(); });
	}
	private async refresh(): Promise<void> {
		if (!this.alive || !this.token || this.refreshing) return;
		this.dirty = false; this.refreshing = true;
		try {
			const reply = await this.api.command(this.token, { type: "snapshot" });
			if (!this.alive) return;
			if (reply.ok && reply.snapshot) this.apply(reply.snapshot);
			else if (!reply.ok) this.update({ errorCode: reply.code, connection: "failed" });
		} catch { if (this.alive) this.update({ errorCode: "CONNECTION_LOST", connection: "failed" }); }
		finally { this.refreshing = false; if (this.dirty && this.alive) this.invalidate(); }
	}
	private apply(snapshot: CodexWorkspaceSnapshot): void {
		const previous = this.state.snapshot;
		if (previous && (previous.instanceId !== snapshot.instanceId || previous.revision > snapshot.revision)) return;
		this.update({ snapshot });
	}
	private update(patch: Partial<CodexWorkspaceClientState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of [...this.listeners]) listener();
	}
}
