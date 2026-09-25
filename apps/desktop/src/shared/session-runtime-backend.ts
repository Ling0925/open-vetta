export type SessionRuntimeBackend = "native" | "codex";

export interface SessionRuntimeBackendState {
	readonly sessionId: string;
	readonly backend: SessionRuntimeBackend;
	/** Changes only when the backend selection changes, not on every streamed message. */
	readonly selectionId: string;
	readonly busy: boolean;
	readonly switching: boolean;
}
export type SessionRuntimeBackendReply =
	| { readonly ok: true; readonly state: SessionRuntimeBackendState }
	| { readonly ok: false; readonly code: string };

export const SESSION_RUNTIME_BACKEND_CHANNELS = {
	READ: "vetta:session:runtime-backend:read",
	SELECT: "vetta:session:runtime-backend:select",
	CHANGED: "vetta:session:runtime-backend:changed",
} as const;
