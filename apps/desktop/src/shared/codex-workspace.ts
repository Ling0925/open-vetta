/** Narrow, local-window contract. No raw RPC, credentials or Native tool execution is exposed. */
export const CODEX_WORKSPACE_CHANNELS = {
	ATTACH: "vetta:codex-workspace:attach",
	COMMAND: "vetta:codex-workspace:command",
	CHANGED: "vetta:codex-workspace:changed",
} as const;

export interface CodexWorkspaceProfile {
	executable: string;
	expectedVersion: string;
	codexHome: string;
	cwd: string;
	sandbox: "read-only" | "workspace-write";
	model?: string;
}
export type CodexWorkspacePhase = "setup" | "ready" | "opening" | "running" | "stopping" | "closing" | "recovery" | "closed";
export interface CodexWorkspaceRow {
	id: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "error" | "note";
	text: string;
	truncated: boolean;
}
export interface CodexWorkspaceApproval {
	id: string;
	sessionId: string;
	inputId: string;
	kind: "command" | "file-change";
	/** Complete request JSON rendered as text. Oversized requests are declined rather than truncated. */
	details: string;
	expiresAt: number;
}
export interface CodexWorkspaceSnapshot {
	instanceId: string;
	revision: number;
	phase: CodexWorkspacePhase;
	profile?: CodexWorkspaceProfile;
	sessionId?: string;
	activeInputId?: string;
	rows: CodexWorkspaceRow[];
	hasEarlierRows: boolean;
	approvals: CodexWorkspaceApproval[];
	sessions: { id: string; name: string; modifiedAt: number }[];
	errorCode?: string;
	outcome?: "completed" | "cancelled" | "failed";
}
export type CodexWorkspaceCommand =
	| { type: "snapshot" }
	| { type: "detach" }
	| { type: "choose"; field: "executable" | "codexHome" | "cwd" }
	| { type: "configure"; profile: CodexWorkspaceProfile }
	| { type: "open"; sessionId?: string }
	| { type: "send"; sessionId: string; inputId: string; text: string }
	| { type: "stop"; sessionId: string; inputId: string }
	| { type: "close" }
	| { type: "approval"; approvalId: string; decision: "accept" | "decline" };
export type CodexWorkspaceReply =
	| { ok: true; snapshot?: CodexWorkspaceSnapshot; chosenPath?: string; acceptedInputId?: string }
	| { ok: false; code: string };
export interface DesktopCodexWorkspaceApi {
	attach(): Promise<{ token: string; snapshot: CodexWorkspaceSnapshot }>;
	command(token: string, command: CodexWorkspaceCommand): Promise<CodexWorkspaceReply>;
	onChanged(listener: (notice: { instanceId: string; revision: number }) => void): () => void;
}
