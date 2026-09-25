import type { ConversationDocument } from "@vetta/runtime-core/conversation";
import type { SessionRuntimeBackend } from "../../shared/session-runtime-backend.js";

export const RUNTIME_BACKEND_ENTRY = "desktop.runtime-backend";
export class RuntimeBackendError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "RuntimeBackendError";
	}
}
export function runtimeBackend(value: unknown): SessionRuntimeBackend {
	if (value !== "native" && value !== "codex") throw new RuntimeBackendError("INPUT");
	return value;
}

/** Selection is conversation metadata, independent of a selected message branch.
 * An invalid/newer record must never silently send the conversation to Native. */
export function readRuntimeBackendChoice(document: ConversationDocument) {
	for (let index = document.entries.length - 1; index >= 0; index--) {
		const entry = document.entries[index];
		if (entry.type !== "custom" || entry.customType !== RUNTIME_BACKEND_ENTRY) continue;
		const data = entry.data;
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			!("schemaVersion" in data) ||
			data.schemaVersion !== 1 ||
			!("backend" in data) ||
			Object.keys(data).some((key) => key !== "schemaVersion" && key !== "backend")
		) {
			throw new RuntimeBackendError("RUNTIME_SELECTION_INVALID");
		}
		return { backend: runtimeBackend(data.backend), selectionId: entry.id };
	}
	return { backend: "native" as const, selectionId: "default" };
}

export function runtimeBackendErrorCode(error: unknown): string {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "RUNTIME_SWITCH_FAILED";
}
