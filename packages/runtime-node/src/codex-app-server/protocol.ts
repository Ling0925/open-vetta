import { CodexRuntimeError, type CodexThread, type CodexTurn, type JsonObject, type RpcId } from "./types.js";
/** Source compatibility reference, not a claim that an arbitrary installed binary has been certified. */
export const CODEX_PROTOCOL_REFERENCE = "openai/codex@b19cebecc0169097bda7539af03c886e03bdeafe";
export function object(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodexRuntimeError("PROTOCOL", "Expected an app-server object");
	}
	return value as JsonObject;
}
export function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new CodexRuntimeError("PROTOCOL", `Invalid app-server ${field}`);
	}
	return value;
}
export function rpcId(value: unknown): RpcId {
	if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)))
		return value;
	throw new CodexRuntimeError("PROTOCOL", "Invalid app-server request ID");
}
export function positive(value: number | undefined, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0 || result > 2147483647) {
		throw new CodexRuntimeError("CONFIGURATION", "Limits must be positive 32-bit integers");
	}
	return result;
}
export function readTurn(value: unknown): CodexTurn {
	const turn = object(value);
	const id = text(turn.id, "turn.id");
	const status = turn.status;
	if (status !== "inProgress" && status !== "completed" && status !== "interrupted" && status !== "failed") {
		throw new CodexRuntimeError("PROTOCOL", "Unknown app-server turn status");
	}
	if (!Array.isArray(turn.items))
		throw new CodexRuntimeError("PROTOCOL", "Missing app-server turn items");
	return { ...turn, id, status, items: turn.items.map(object), ...(turn.error === undefined ? {} : { error: turn.error }) };
}
export function readThread(value: unknown): CodexThread {
	const thread = object(value);
	if (!Array.isArray(thread.turns))
		throw new CodexRuntimeError("PROTOCOL", "Missing app-server thread history");
	return {
		id: text(thread.id, "thread.id"),
		...(typeof thread.sessionId === "string" ? { sessionId: thread.sessionId } : {}),
		turns: thread.turns.map((value) => { readTurn(value); return object(value); }),
	};
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
	// A host may subscribe to events before awaiting completion; rejection must not become unhandled meanwhile.
	void promise.catch(() => undefined);
	return { promise, resolve, reject };
}
export function safeNotify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
	for (const listener of [...listeners]) {
		try {
			void Promise.resolve(listener(structuredClone(value))).catch(() => undefined);
		}
		catch { /* Observers cannot control execution. */ }
	}
}
