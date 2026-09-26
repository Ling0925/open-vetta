import { describe, expect, it } from "vitest";
import type { StoredConversation } from "../../src/kernel/contracts.js";
import { lookupRuntimeInputAdmission } from "../../src/kernel/input-admission.js";

function conversation(events: StoredConversation["events"]): StoredConversation {
	return { sessionId: "session", createdAt: 1, version: events.length, messages: [], events };
}

const identity = (turnId: string, inputId: string) =>
	({
		type: "context.appended",
		sessionId: "session",
		turnId,
		record: {
			type: "runtime.input.identity",
			content: "",
			modelVisible: false,
			display: false,
			metadata: { inputId },
		},
		timestamp: 1,
	}) as const;

describe("runtime input admission lookup", () => {
	it("resolves the durable terminal state for one input identity", () => {
		expect(
			lookupRuntimeInputAdmission(
				conversation([
					identity("turn-1", "input-1"),
					{ type: "turn.completed", sessionId: "session", turnId: "turn-1", stopReason: "stop", timestamp: 2 },
				]),
				"input-1",
			),
		).toEqual({ state: "admitted", inputId: "input-1", turnId: "turn-1", terminal: "completed" });
	});

	it("reports an admitted input without a terminal record as active", () => {
		expect(lookupRuntimeInputAdmission(conversation([identity("turn-1", "input-1")]), "input-1")).toEqual({
			state: "admitted",
			inputId: "input-1",
			turnId: "turn-1",
			terminal: "active",
		});
	});

	it("fails closed when one input identity appears under more than one turn", () => {
		expect(
			lookupRuntimeInputAdmission(
				conversation([identity("turn-1", "input-1"), identity("turn-2", "input-1")]),
				"input-1",
			),
		).toEqual({ state: "ambiguous", inputId: "input-1", turnIds: ["turn-1", "turn-2"] });
	});
});
