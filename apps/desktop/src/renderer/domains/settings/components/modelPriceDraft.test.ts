import { describe, expect, it } from "vitest";
import { emptyModelPrice, modelPriceToDraft, parseModelPrice } from "./modelPriceDraft";

describe("model price draft", () => {
	it("keeps missing prices unknown instead of turning them into free calls", () => {
		expect(parseModelPrice(emptyModelPrice)).toBeUndefined();
		expect(modelPriceToDraft(undefined)).toEqual(emptyModelPrice);
	});

	it("accepts explicit free rates and fractional USD prices per million tokens", () => {
		expect(parseModelPrice({ input: "0", output: "0", cacheRead: "0", cacheWrite: "0" })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		const price = { input: 1.25, output: 8, cacheRead: 0.125, cacheWrite: 2 };
		expect(parseModelPrice(modelPriceToDraft(price))).toEqual(price);
	});

	it("rejects partial, negative, and non-finite prices rather than saving misleading estimates", () => {
		expect(parseModelPrice({ input: "1", output: "", cacheRead: "0", cacheWrite: "0" })).toBeNull();
		expect(parseModelPrice({ input: "-1", output: "1", cacheRead: "0", cacheWrite: "0" })).toBeNull();
		expect(parseModelPrice({ input: "Infinity", output: "1", cacheRead: "0", cacheWrite: "0" })).toBeNull();
	});
});
