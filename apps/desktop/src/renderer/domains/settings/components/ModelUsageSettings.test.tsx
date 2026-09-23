// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localModelsConfigAtom } from "@shared/store/model-catalog-atoms";
import { ModelUsageSettings } from "./ModelUsageSettings";

const SUMMARY = {
	from: Date.UTC(2026, 8, 23, 0, 0, 0),
	to: Date.UTC(2026, 8, 24, 0, 0, 0),
	requests: 3,
	errors: 0,
	input: 57_000_000,
	output: 10_600_000,
	cacheRead: 116_800_000,
	cacheWrite: 7_800_000,
	totalTokens: 192_200_000,
	costTotal: 50.02,
	models: [
		{
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			requests: 2,
			errors: 0,
			input: 21_800_000,
			output: 3_000_000,
			cacheRead: 54_600_000,
			cacheWrite: 3_800_000,
			totalTokens: 83_200_000,
			costTotal: 26.48,
			totalDurationMs: 120_000,
			maxDurationMs: 90_000,
			outputSpeed: 78,
			buckets: [
				{ startedAt: Date.UTC(2026, 8, 23, 14, 0, 0), requests: 2, errors: 0, input: 10_000_000, output: 1_500_000, cacheRead: 27_000_000, cacheWrite: 1_800_000, costTotal: 13.0 },
			],
		},
		{
			provider: "openai",
			model: "gpt-5.4",
			api: "openai-responses",
			requests: 1,
			errors: 0,
			input: 12_400_000,
			output: 2_200_000,
			cacheRead: 21_800_000,
			cacheWrite: 1_600_000,
			totalTokens: 38_000_000,
			costTotal: 13.45,
			totalDurationMs: 60_000,
			maxDurationMs: 60_000,
			outputSpeed: 71,
			buckets: [
				{ startedAt: Date.UTC(2026, 8, 23, 14, 0, 0), requests: 1, errors: 0, input: 6_000_000, output: 1_000_000, cacheRead: 10_000_000, cacheWrite: 800_000, costTotal: 6.0 },
			],
		},
	],
};

const CONFIG = {
	providers: {
		anthropic: {
			api: "anthropic-messages",
			models: [
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
			],
		},
		openai: {
			api: "openai-responses",
			models: [{ id: "gpt-5.4", name: "GPT-5.4", cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 } }],
		},
	},
	defaultModel: "anthropic/claude-sonnet-4-5",
};

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			if (params) return `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})`;
			return key;
		},
	}),
}));

const summaryMock = vi.fn();
const exportCsvMock = vi.fn();
const backfillCostMock = vi.fn();

beforeEach(() => {
	summaryMock.mockResolvedValue(SUMMARY);
	exportCsvMock.mockResolvedValue({ path: "/tmp/export.csv", count: 3, preview: "" });
	backfillCostMock.mockResolvedValue({ updated: 2 });
	getDefaultStore().set(localModelsConfigAtom, CONFIG);
	Object.defineProperty(window, "vetta", {
		value: {
			...window.vetta,
			modelUsage: {
				summary: summaryMock,
				exportCsv: exportCsvMock,
				backfillCost: backfillCostMock,
			},
		},
		configurable: true,
		writable: true,
	});
});

describe("ModelUsageSettings", () => {
	it("加载后展示顶部统计与模型明细，并触发 summary IPC", async () => {
		render(<ModelUsageSettings />);
		await waitFor(() => expect(summaryMock).toHaveBeenCalled());
		expect(await screen.findByText("$50.02")).toBeTruthy();
		expect(screen.getByText("192.2M")).toBeTruthy();
		expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
		expect(screen.getByText("GPT-5.4")).toBeTruthy();
		expect(screen.getByText("$26.48")).toBeTruthy();
	});

	it("切到「价格标准与账单拆解」后展示热力矩阵与单价目录，可导出 CSV", async () => {
		const user = userEvent.setup();
		render(<ModelUsageSettings />);
		await screen.findByText("Claude Sonnet 4.5");
		await user.click(screen.getByRole("button", { name: /pricingLink/i }));
		expect(await screen.findByText(/heatmapTitle/i)).toBeTruthy();
		expect(screen.getByText(/catalogTitle/i)).toBeTruthy();
		expect(screen.getByText("$3.00")).toBeTruthy();
		expect(screen.getByText("$15.00")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: /exportCsv/i }));
		await waitFor(() => expect(exportCsvMock).toHaveBeenCalled());
	});

	it("空数据时展示空态提示", async () => {
		summaryMock.mockResolvedValue({ ...SUMMARY, requests: 0, models: [] });
		render(<ModelUsageSettings />);
		expect(await screen.findByText("modelUsage.empty")).toBeTruthy();
	});
});
