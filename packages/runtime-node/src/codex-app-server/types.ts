/** Host-side adapter contracts; Codex remains the owner of the agent loop and history. */
export type RpcId = string | number;
export type JsonObject = Readonly<Record<string, unknown>>;
export class CodexRuntimeError extends Error {
	constructor(readonly code: string, message: string, readonly method?: string, readonly rpcCode?: number) {
		super(message);
		this.name = "CodexRuntimeError";
	}
}
export type TransportEvent = {
	type: "message";
	message: unknown;
} | {
	type: "failure";
	error: Error;
};
export interface CodexTransport {
	subscribe(listener: (event: TransportEvent) => void): () => void;
	send(message: JsonObject): Promise<void>;
	close(): Promise<void>;
}
export interface ServerRequest {
	readonly id: RpcId;
	readonly method: string;
	readonly params: JsonObject;
	readonly signal: AbortSignal;
}
export interface RpcOptions {
	readonly requestTimeoutMs?: number;
	readonly serverRequestTimeoutMs?: number;
	readonly maxPendingRequests?: number;
	readonly onRequest?: (request: ServerRequest) => Promise<unknown>;
}
export interface CodexLaunchOptions {
	/** Trusted host configuration only. Never derive an executable or arguments from model output. */
	readonly executable: string;
	/** For a trusted Node entrypoint, e.g. ["/absolute/path/to/codex.js"]. Never enables shell parsing. */
	readonly executableArgs?: readonly string[];
	readonly expectedVersion: string;
	readonly cwd: string;
	readonly codexHome?: string;
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly maxFrameBytes?: number;
}
export interface CodexThread {
	readonly id: string;
	readonly sessionId?: string;
	readonly turns: readonly JsonObject[];
}
export interface CodexTurn {
	readonly id: string;
	readonly status: "inProgress" | "completed" | "interrupted" | "failed";
	readonly items: readonly JsonObject[];
	readonly error?: unknown;
}
export type CodexSessionState = "idle" | "starting" | "running" | "cancelling" | "recovery-required" | "closed";
export type ApprovalDecision = "accept" | "decline" | "cancel";
export interface CodexSessionOptions {
	readonly interruptTimeoutMs?: number;
	readonly turnTimeoutMs?: number;
	/** The host must display the exact request. No persistent/session-wide grants are supported. */
	readonly onApproval?: (request: ServerRequest) => Promise<ApprovalDecision>;
}
export interface OpenCodexSessionOptions extends CodexLaunchOptions, Omit<RpcOptions, "onRequest">, CodexSessionOptions {
	readonly threadId?: string;
	readonly model?: string;
	readonly sandbox?: "read-only" | "workspace-write";
}
export interface CodexTurnHandle {
	readonly turnId: string;
	/** Settles only on a matching turn/completed notification, never on the start/interrupt acknowledgment. */
	readonly completed: Promise<CodexTurn>;
}
export interface CodexSessionEvent {
	readonly instanceId: string;
	readonly sequence: number;
	readonly threadId: string;
	readonly method: string;
	readonly params: JsonObject;
}
