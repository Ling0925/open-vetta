import { describe, expect, it } from "vitest";
import { ModelUsageService, summarizeModelUsageRecords } from "./model-usage-service.js";
import type { ModelUsageLedger } from "./usage-ledger.js";
import type { ModelUsageRecord } from "./usage-record.js";

const BASE_AT = Date.UTC(2026, 8, 20, 10, 0, 0);

function record(overrides: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
	return {
		schemaVersion: 1,
		at: BASE_AT,
		provider: "LingAPI",
		model: "kimi-k3-1",
		input: 1000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 0,
		costTotal: 0.005,
		state: "completed",
		...overrides,
	};
}

describe("summarizeModelUsageRecords", () => {
	it("聚合 requests/tokens/cost，并按 cost 倒序排模型", () => {
		const summary = summarizeModelUsageRecords([
			record(),
			record({ at: BASE_AT + 60 * 1000, costTotal: 0.01, model: "deepseek-v4" }),
			record({ at: BASE_AT + 120 * 1000, state: "error" }),
		]);
		expect(summary.requests).toBe(3);
		expect(summary.errors).toBe(1);
		expect(summary.input).toBe(3000);
		expect(summary.costTotal).toBeCloseTo(0.02, 6);
		// kimi-k3-1 两条记录累计 0.015，高于 deepseek-v4 的单条 0.01。
		expect(summary.models.map((model) => model.model)).toEqual(["kimi-k3-1", "deepseek-v4"]);
	});

	it("2 小时 bucket 聚合同一时段", () => {
		const summary = summarizeModelUsageRecords([
			record(),
			record({ at: BASE_AT + 30 * 60 * 1000 }),
			record({ at: BASE_AT + 3 * 60 * 60 * 1000 }),
		]);
		const model = summary.models[0];
		expect(model.buckets).toHaveLength(2);
		expect(model.buckets[0].requests).toBe(2);
		expect(model.buckets[1].requests).toBe(1);
	});

	it("outputSpeed 按 output / 时长计算", () => {
		const summary = summarizeModelUsageRecords([
			record({ output: 400, durationMs: 2000 }),
			record({ output: 200, durationMs: 1000 }),
		]);
		expect(summary.models[0].outputSpeed).toBeCloseTo(200, 3);
	});

	it("空输入返回全零", () => {
		const summary = summarizeModelUsageRecords([]);
		expect(summary.requests).toBe(0);
		expect(summary.models).toEqual([]);
		expect(summary.totalTokens).toBe(0);
	});
});

describe("ModelUsageService.summary", () => {
	it("返回用户选择的时间窗口，而不是数据的首末时间", async () => {
		const from = BASE_AT - 24 * 60 * 60 * 1000;
		const to = BASE_AT + 60 * 60 * 1000;
		const ledger = { read: async () => [record()] } as unknown as ModelUsageLedger;
		const summary = await new ModelUsageService(ledger).summary({ from, to });
		expect(summary).toMatchObject({ from, to, requests: 1 });
	});

	it("空范围也保留选定窗口供时间刻度与空态使用", async () => {
		const from = BASE_AT - 24 * 60 * 60 * 1000;
		const to = BASE_AT;
		const ledger = { read: async () => [] } as unknown as ModelUsageLedger;
		const summary = await new ModelUsageService(ledger).summary({ from, to });
		expect(summary).toMatchObject({ from, to, requests: 0 });
	});
});
