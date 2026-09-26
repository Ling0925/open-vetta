import type { RuntimeInputReconciliation } from "@vetta/runtime-core";

export type PromptDeliveryReconciliation =
	| { readonly kind: "missing" }
	| { readonly kind: "running"; readonly turnId: string }
	| { readonly kind: "completed"; readonly turnId: string }
	| { readonly kind: "failed"; readonly turnId: string; readonly message: string }
	| { readonly kind: "cancelled"; readonly turnId: string }
	| { readonly kind: "transferred"; readonly turnId: string; readonly targetSessionId: string }
	| { readonly kind: "ambiguous"; readonly turnIds: readonly string[] };

export function classifyPromptDeliveryReconciliation(
	receipt: RuntimeInputReconciliation,
): PromptDeliveryReconciliation {
	switch (receipt.status) {
		case "missing":
			return { kind: "missing" };
		case "active":
			return { kind: "running", turnId: receipt.turnId };
		case "completed":
			return { kind: "completed", turnId: receipt.turnId };
		case "failed":
			return { kind: "failed", turnId: receipt.turnId, message: receipt.error.message };
		case "cancelled":
			return { kind: "cancelled", turnId: receipt.turnId };
		case "transferred":
			return { kind: "transferred", turnId: receipt.turnId, targetSessionId: receipt.targetSessionId };
		case "ambiguous":
			return { kind: "ambiguous", turnIds: receipt.turnIds };
	}
}
