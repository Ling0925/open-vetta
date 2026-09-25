import type { RuntimeSessionTurnControl } from "@vetta/runtime-core";
import { CodexWorkspaceError, errorCode } from "./validation.js";

type Outcome = { status: "completed" | "cancelled" | "failed"; errorCode?: string };
type TurnControl = Pick<RuntimeSessionTurnControl, "promptWhenAvailable" | "abort">;
interface Admission {
	readonly controller: AbortController;
	readonly result: Promise<Outcome>;
	dispatched: boolean;
	stop?: Promise<void>;
}

/** Owns preparation and dispatch as one cancellable operation, not a second Agent Loop. */
export class WorkspaceTurnAdmission {
	private active?: Admission;
	private closing?: Promise<void>;
	private recovery = false;

	constructor(
		private readonly control: TurnControl,
		private readonly prepare?: (signal: AbortSignal) => Promise<void>,
	) {}

	requiresRecovery(): boolean {
		return this.recovery;
	}

	prompt(text: string): Promise<Outcome> {
		if (this.closing) return Promise.reject(new CodexWorkspaceError("CLOSED"));
		if (this.recovery) return Promise.reject(new CodexWorkspaceError("RECOVERY_REQUIRED"));
		if (this.active) return Promise.reject(new CodexWorkspaceError("BUSY"));
		if (!text.trim()) return Promise.reject(new CodexWorkspaceError("INPUT"));
		const controller = new AbortController();
		// Publish ownership before preparation or a runtime callback can yield/re-enter.
		const admission: Admission = {
			controller, dispatched: false,
			result: Promise.resolve().then(() => this.execute(admission, text)),
		};
		this.active = admission;
		return admission.result;
	}

	stop(): Promise<void> {
		const admission = this.active;
		if (!admission) return Promise.resolve();
		if (admission.stop) return admission.stop;
		admission.stop = Promise.resolve().then(async () => {
			try {
				// An old stop must not target a new operation admitted after the old terminal result.
				if (this.active === admission && admission.dispatched) await this.control.abort();
				await admission.result;
			} catch (error) {
				this.recovery = true;
				throw error;
			} finally {
				if (this.active === admission) this.active = undefined;
			}
		});
		admission.controller.abort();
		return admission.stop;
	}

	close(release: () => Promise<void>): Promise<void> {
		if (this.closing) return this.closing;
		const admission = this.active;
		this.closing = Promise.resolve().then(async () => {
			// A failed process shutdown must surface even if its task never produces a result.
			const settledTask = admission?.result.catch(() => undefined);
			await release();
			await settledTask;
		});
		admission?.controller.abort();
		return this.closing;
	}

	private async execute(admission: Admission, text: string): Promise<Outcome> {
		const signal = admission.controller.signal;
		try {
			signal.throwIfAborted();
			await this.prepare?.(signal);
			signal.throwIfAborted();
			admission.dispatched = true;
			const result = await this.control.promptWhenAvailable({ text }, signal);
			if (!result || (result.status !== "completed" && result.status !== "cancelled" && result.status !== "failed")) {
				throw new CodexWorkspaceError("OUTCOME_UNKNOWN");
			}
			return { status: result.status, ...(result.error ? { errorCode: errorCode(result.error) } : {}) };
		} catch (error) {
			// Only cancellation of preparation itself is locally provable. Never rewrite a runtime
			// failure or an unconfirmed external effect as a successful stop.
			if (!admission.dispatched && signal.aborted && error === signal.reason) return { status: "cancelled" };
			this.recovery = true;
			throw error;
		} finally {
			if (this.active === admission && !admission.stop) this.active = undefined;
		}
	}
}
