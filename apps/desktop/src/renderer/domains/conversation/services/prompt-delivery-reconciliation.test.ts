import { describe, expect, it } from "vitest";
import { classifyPromptDeliveryReconciliation } from "./prompt-delivery-reconciliation";

describe("prompt delivery reconciliation", () => {
	it("treats active and completed durable inputs as accepted instead of retry candidates", () => {
		expect(
			classifyPromptDeliveryReconciliation({ status: "active", inputId: "input", turnId: "turn-1" }),
		).toEqual({ kind: "running", turnId: "turn-1" });
		expect(
			classifyPromptDeliveryReconciliation({
				status: "completed",
				inputId: "input",
				turnId: "turn-1",
				stopReason: "stop",
				timestamp: 2,
			}),
		).toEqual({ kind: "completed", turnId: "turn-1" });
	});

	it("keeps failed, cancelled and ambiguous durable states non-replayable", () => {
		expect(
			classifyPromptDeliveryReconciliation({
				status: "failed",
				inputId: "input",
				turnId: "turn-1",
				error: { code: "fixture", message: "failed" },
				timestamp: 2,
			}),
		).toEqual({ kind: "failed", turnId: "turn-1", message: "failed" });
		expect(
			classifyPromptDeliveryReconciliation({
				status: "cancelled",
				inputId: "input",
				turnId: "turn-1",
				timestamp: 2,
			}),
		).toEqual({ kind: "cancelled", turnId: "turn-1" });
		expect(
			classifyPromptDeliveryReconciliation({
				status: "ambiguous",
				inputId: "input",
				turnIds: ["turn-1", "turn-2"],
				reason: "multiple_turns",
			}),
		).toEqual({ kind: "ambiguous", turnIds: ["turn-1", "turn-2"] });
	});
});
