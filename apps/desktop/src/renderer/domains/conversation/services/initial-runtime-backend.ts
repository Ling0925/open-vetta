import type { SessionRuntimeBackend, SessionRuntimeBackendReply } from "../../../../shared/session-runtime-backend";

interface SessionBackendApi {
	getRuntimeBackend(sessionId: string): Promise<SessionRuntimeBackendReply>;
	setRuntimeBackend(
		sessionId: string,
		backend: SessionRuntimeBackend,
		expectedSelectionId: string,
	): Promise<SessionRuntimeBackendReply>;
}
/** The first user prompt must not run on Native while an explicitly selected Codex backend is still being validated. */
export async function applyInitialRuntimeBackend(
	api: SessionBackendApi,
	sessionId: string,
	backend?: SessionRuntimeBackend,
): Promise<void> {
	if (backend === undefined) return;
	const current = await api.getRuntimeBackend(sessionId);
	if (!current.ok) throw new Error(current.code);
	if (current.state.backend === backend && !current.state.switching) return;
	const selected = await api.setRuntimeBackend(sessionId, backend, current.state.selectionId);
	if (!selected.ok) throw new Error(selected.code);
	if (selected.state.backend !== backend || selected.state.switching) throw new Error("RUNTIME_SELECTION_CONFLICT");
}
