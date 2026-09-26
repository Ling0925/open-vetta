import type { StoredConversation } from "./contracts.js";

export const RUNTIME_INPUT_IDENTITY_CONTEXT_TYPE = "runtime.input.identity";

export type RuntimeInputTerminalState = "active" | "completed" | "cancelled" | "failed" | "transferred";

export type RuntimeInputAdmissionLookup =
	| { readonly state: "missing"; readonly inputId: string }
	| {
			readonly state: "admitted";
			readonly inputId: string;
			readonly turnId: string;
			readonly terminal: RuntimeInputTerminalState;
	  }
	| {
			readonly state: "ambiguous";
			readonly inputId: string;
			readonly turnIds: readonly string[];
	  };

export function lookupRuntimeInputAdmission(
	conversation: Pick<StoredConversation, "events">,
	inputId: string,
): RuntimeInputAdmissionLookup {
	const turnIds = new Set<string>();
	const terminal = new Map<string, RuntimeInputTerminalState>();
	for (const event of conversation.events) {
		switch (event.type) {
			case "turn.completed":
				terminal.set(event.turnId, "completed");
				break;
			case "turn.cancelled":
				terminal.set(event.turnId, "cancelled");
				break;
			case "turn.failed":
				terminal.set(event.turnId, "failed");
				break;
			case "turn.transferred":
				terminal.set(event.turnId, "transferred");
				break;
			case "context.appended": {
				if (event.record.type !== RUNTIME_INPUT_IDENTITY_CONTEXT_TYPE) break;
				const metadata = readRecord(event.record.metadata);
				if (metadata?.inputId === inputId) turnIds.add(event.turnId);
				break;
			}
		}
	}
	if (turnIds.size === 0) return { state: "missing", inputId };
	if (turnIds.size > 1) return { state: "ambiguous", inputId, turnIds: [...turnIds].sort() };
	const turnId = [...turnIds][0];
	return {
		state: "admitted",
		inputId,
		turnId,
		terminal: terminal.get(turnId) ?? "active",
	};
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
