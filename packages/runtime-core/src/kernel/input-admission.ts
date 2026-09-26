import type { ConversationDocument } from "../conversation/document.js";
import type { StoredConversation } from "./contracts.js";

export const RUNTIME_INPUT_IDENTITY_CONTEXT_TYPE = "runtime.input.identity";

export type RuntimeInputTerminalState = "active" | "completed" | "cancelled" | "failed" | "transferred";

export type RuntimeInputReconciliation =
	| { readonly status: "missing"; readonly inputId: string }
	| {
			readonly status: "active";
			readonly inputId: string;
			readonly turnId: string;
	  }
	| {
			readonly status: "completed";
			readonly inputId: string;
			readonly turnId: string;
			readonly stopReason: Extract<StoredConversation["events"][number], { type: "turn.completed" }>["stopReason"];
			readonly timestamp: number;
	  }
	| {
			readonly status: "cancelled";
			readonly inputId: string;
			readonly turnId: string;
			readonly reason?: string;
			readonly timestamp: number;
	  }
	| {
			readonly status: "failed";
			readonly inputId: string;
			readonly turnId: string;
			readonly error: Extract<StoredConversation["events"][number], { type: "turn.failed" }>["error"];
			readonly timestamp: number;
	  }
	| {
			readonly status: "transferred";
			readonly inputId: string;
			readonly turnId: string;
			readonly targetSessionId: string;
			readonly reason: string;
			readonly timestamp: number;
	  }
	| {
			readonly status: "ambiguous";
			readonly inputId: string;
			readonly turnIds: readonly string[];
			readonly reason: "multiple_turns" | "multiple_terminal_records";
	  };

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

export function reconcileRuntimeInput(
	conversation: Pick<StoredConversation, "events">,
	inputId: string,
	document?: Pick<ConversationDocument, "entries">,
): RuntimeInputReconciliation {
	const turnIds = collectTurnIds(conversation, document, inputId);
	if (turnIds.size === 0) return { status: "missing", inputId };
	if (turnIds.size > 1) {
		return { status: "ambiguous", inputId, turnIds: [...turnIds].sort(), reason: "multiple_turns" };
	}
	const turnId = [...turnIds][0];
	const terminalEvents = conversation.events.filter(
		(event) =>
			"turnId" in event &&
			event.turnId === turnId &&
			(event.type === "turn.completed" ||
				event.type === "turn.cancelled" ||
				event.type === "turn.failed" ||
				event.type === "turn.transferred"),
	);
	if (terminalEvents.length > 1) {
		return {
			status: "ambiguous",
			inputId,
			turnIds: [turnId],
			reason: "multiple_terminal_records",
		};
	}
	const terminal = terminalEvents[0];
	if (!terminal) return { status: "active", inputId, turnId };
	if (terminal.type === "turn.completed") {
		return {
			status: "completed",
			inputId,
			turnId,
			stopReason: terminal.stopReason,
			timestamp: terminal.timestamp,
		};
	}
	if (terminal.type === "turn.cancelled") {
		return {
			status: "cancelled",
			inputId,
			turnId,
			...(terminal.reason ? { reason: terminal.reason } : {}),
			timestamp: terminal.timestamp,
		};
	}
	if (terminal.type === "turn.failed") {
		return { status: "failed", inputId, turnId, error: terminal.error, timestamp: terminal.timestamp };
	}
	return {
		status: "transferred",
		inputId,
		turnId,
		targetSessionId: terminal.targetSessionId,
		reason: terminal.reason,
		timestamp: terminal.timestamp,
	};
}

export function lookupRuntimeInputAdmission(
	conversation: Pick<StoredConversation, "events">,
	inputId: string,
	document?: Pick<ConversationDocument, "entries">,
): RuntimeInputAdmissionLookup {
	const receipt = reconcileRuntimeInput(conversation, inputId, document);
	if (receipt.status === "missing") return { state: "missing", inputId };
	if (receipt.status === "ambiguous") return { state: "ambiguous", inputId, turnIds: receipt.turnIds };
	return {
		state: "admitted",
		inputId,
		turnId: receipt.turnId,
		terminal: receipt.status,
	};
}

function collectTurnIds(
	conversation: Pick<StoredConversation, "events">,
	document: Pick<ConversationDocument, "entries"> | undefined,
	inputId: string,
): Set<string> {
	const turnIds = new Set<string>();
	for (const event of conversation.events) {
		if (event.type !== "context.appended" || event.record.type !== RUNTIME_INPUT_IDENTITY_CONTEXT_TYPE) continue;
		const metadata = readRecord(event.record.metadata);
		if (metadata?.inputId === inputId) turnIds.add(event.turnId);
	}
	for (const entry of document?.entries ?? []) {
		if (entry.type !== "custom_message" || entry.customType !== RUNTIME_INPUT_IDENTITY_CONTEXT_TYPE) continue;
		const details = readRecord(entry.details);
		if (details?.inputId !== inputId || typeof details.turnId !== "string" || details.turnId.length === 0) continue;
		turnIds.add(details.turnId);
	}
	return turnIds;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
