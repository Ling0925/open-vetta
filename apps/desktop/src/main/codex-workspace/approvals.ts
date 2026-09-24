import { randomUUID } from "node:crypto";
import type { CodexWorkspaceApproval } from "../../shared/codex-workspace.js";
import { CodexWorkspaceError } from "./validation.js";

export interface WorkspaceApprovalRequest {
	method: string;
	params: Readonly<Record<string, unknown>>;
	signal: AbortSignal;
}
interface Pending { view: CodexWorkspaceApproval; finish(value: "accept" | "decline" | "cancel"): void; }
/** No grants survive view detachment, a stopped task, a new task or the request's AbortSignal. */
export class CodexWorkspaceApprovals {
	private readonly pending = new Map<string, Pending>();
	constructor(private readonly changed: () => void, private readonly timeoutMs = 55000) { }
	list(): CodexWorkspaceApproval[] { return [...this.pending.values()].map(p => ({ ...p.view })); }
	request(request: WorkspaceApprovalRequest, sessionId: string, inputId: string): Promise<"accept" | "decline" | "cancel"> {
		if (request.signal.aborted) return Promise.resolve("cancel");
		if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) return Promise.resolve("decline");
		const details = JSON.stringify(request.params, null, 2);
		if (Buffer.byteLength(details) > 65536 || this.pending.size >= 8) return Promise.resolve("decline");
		const id = randomUUID();
		return new Promise(resolve => {
			let done = false;
			const finish = (value: "accept" | "decline" | "cancel") => {
				if (done) return;
				done = true; clearTimeout(timer); request.signal.removeEventListener("abort", abort);
				this.pending.delete(id); resolve(value); this.changed();
			};
			const abort = () => finish("cancel");
			const timer = setTimeout(() => finish("decline"), this.timeoutMs);
			this.pending.set(id, {
				view: {
					id, sessionId, inputId,
					kind: request.method === "item/commandExecution/requestApproval" ? "command" : "file-change",
					details, expiresAt: Date.now() + this.timeoutMs
				}, finish
			});
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort();
			this.changed();
		});
	}
	decide(id: string, decision: "accept" | "decline", sessionId?: string, inputId?: string): void {
		const pending = this.pending.get(id);
		if (!pending || pending.view.sessionId !== sessionId || pending.view.inputId !== inputId || pending.view.expiresAt <= Date.now()) {
			pending?.finish("cancel"); throw new CodexWorkspaceError("APPROVAL_EXPIRED");
		}
		pending.finish(decision);
	}
	cancelAll(): void { for (const pending of [...this.pending.values()]) pending.finish("cancel"); }
}
