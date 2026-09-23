import type { ModelsConfigData } from "@preload/api.js";

export type ModelPrice = NonNullable<NonNullable<ModelsConfigData["providers"][string]["models"]>[number]["cost"]>;
export const MODEL_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type ModelPriceField = (typeof MODEL_PRICE_FIELDS)[number];
export type ModelPriceDraft = Record<ModelPriceField, string>;

export const emptyModelPrice: ModelPriceDraft = { input: "", output: "", cacheRead: "", cacheWrite: "" };

export function modelPriceToDraft(cost: ModelPrice | undefined): ModelPriceDraft {
	return cost
		? {
				input: String(cost.input),
				output: String(cost.output),
				cacheRead: String(cost.cacheRead),
				cacheWrite: String(cost.cacheWrite),
			}
		: { ...emptyModelPrice };
}

/** Omitted prices remain unknown; an explicitly free model needs four zero rates. */
export function parseModelPrice(draft: ModelPriceDraft): ModelPrice | undefined | null {
	const values = MODEL_PRICE_FIELDS.map((field) => draft[field].trim());
	if (values.every((value) => value === "")) return undefined;
	if (values.some((value) => value === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) return null;
	return {
		input: Number(draft.input),
		output: Number(draft.output),
		cacheRead: Number(draft.cacheRead),
		cacheWrite: Number(draft.cacheWrite),
	};
}
