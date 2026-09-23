import type { ModelsConfigData, ModelUsageSummary } from "@preload/api";
import { localModelsConfigAtom, modelCatalog } from "@shared/store/model-catalog";
import { showToast } from "@shared/store/toast-atoms";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ModelUsageRange = "24h" | "7d" | "30d" | "billingCycle";
export type ModelUsageView = "overview" | "pricing";

const MODEL_COLORS = ["indigo", "cyan", "emerald", "amber", "pink", "violet", "slate"] as const;

export interface ModelUsageQuery {
	readonly from: number;
	readonly to: number;
}

function rangeToMs(range: ModelUsageRange, now: number): { from: number; to: number } {
	if (range === "24h") return { from: now - 24 * 60 * 60 * 1000, to: now };
	if (range === "7d") return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
	if (range === "30d") return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
	// billingCycle: 当前自然月 1 号 00:00 起
	const date = new Date(now);
	date.setDate(1);
	date.setHours(0, 0, 0, 0);
	return { from: date.getTime(), to: now };
}

export function useModelUsageQuery(range: ModelUsageRange): ModelUsageQuery {
	return useMemo(() => rangeToMs(range, Date.now()), [range]);
}

export interface ModelUsageModelState {
	readonly view: ModelUsageView;
	readonly range: ModelUsageRange;
	readonly metric: "tokens" | "cost" | "requests";
	readonly loading: boolean;
	readonly exporting: boolean;
	readonly summary: ModelUsageSummary | null;
	readonly selectedSlotKey: string | undefined;
	readonly defaultModelKey: string | undefined;
}

export interface ModelUsageModelActions {
	readonly setView: (view: ModelUsageView) => void;
	readonly setRange: (range: ModelUsageRange) => void;
	readonly setMetric: (metric: "tokens" | "cost" | "requests") => void;
	readonly setSelectedSlotKey: (key: string | undefined) => void;
	readonly exportCsv: () => Promise<void>;
	readonly syncOfficialPrices: () => Promise<void>;
}

export interface ModelUsageModel {
	readonly state: ModelUsageModelState;
	readonly actions: ModelUsageModelActions;
	readonly config: ModelsConfigData | null;
}

export function useModelUsageModel(): ModelUsageModel {
	const { t } = useTranslation("settings");
	const config = useAtomValue(localModelsConfigAtom);
	const [view, setView] = useState<ModelUsageView>("overview");
	const [range, setRange] = useState<ModelUsageRange>("24h");
	const [metric, setMetric] = useState<"tokens" | "cost" | "requests">("tokens");
	const [loading, setLoading] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [summary, setSummary] = useState<ModelUsageSummary | null>(null);
	const [selectedSlotKey, setSelectedSlotKey] = useState<string | undefined>(undefined);
	const requestSeq = useRef(0);

	const query = useModelUsageQuery(range);

	useEffect(() => {
		void modelCatalog.revalidate({ sources: ["local"] });
	}, []);

	useEffect(() => {
		const seq = ++requestSeq.current;
		setLoading(true);
		window.vetta.modelUsage
			.summary(query)
			.then((result) => {
				if (requestSeq.current === seq) setSummary(result);
			})
			.catch(() => {
				if (requestSeq.current === seq) setSummary(null);
			})
			.finally(() => {
				if (requestSeq.current === seq) setLoading(false);
			});
	}, [query]);

	const defaultModelKey = useMemo(() => {
		const key = config?.defaultModel;
		return typeof key === "string" && key.includes("/") ? key : undefined;
	}, [config?.defaultModel]);

	const exportCsv = useCallback(async () => {
		setExporting(true);
		try {
			const result = await window.vetta.modelUsage.exportCsv(query);
			if (result) {
				showToast({
					variant: "success",
					message: t("modelUsage.pricing.exported", { count: result.count, path: result.path }),
				});
			}
		} catch (error) {
			showToast({ variant: "error", message: String(error) });
		} finally {
			setExporting(false);
		}
	}, [query, t]);

	const syncOfficialPrices = useCallback(async () => {
		try {
			const result = await window.vetta.modelUsage.backfillCost(query);
			showToast({ variant: "success", message: t("modelUsage.pricing.backfillDone", { count: result.updated }) });
			// 重拉汇总
			const next = await window.vetta.modelUsage.summary(query);
			setSummary(next);
		} catch (error) {
			showToast({ variant: "error", message: String(error) });
		}
	}, [query, t]);

	return {
		state: {
			view,
			range,
			metric,
			loading,
			exporting,
			summary,
			selectedSlotKey,
			defaultModelKey,
		},
		actions: { setView, setRange, setMetric, setSelectedSlotKey, exportCsv, syncOfficialPrices },
		config,
	};
}

/** 给模型分配稳定颜色（按 provider/model 字符串散列到调色板）。 */
export function modelColorOf(provider: string, model: string): string {
	const key = `${provider}/${model}`;
	let hash = 0;
	for (let index = 0; index < key.length; index += 1) {
		hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
	}
	return MODEL_COLORS[hash % MODEL_COLORS.length];
}

/** 从 models.json 查某个 (provider, model) 的显示名与单价。 */
export function lookupModelMeta(
	config: ModelsConfigData | null,
	provider: string,
	model: string,
): {
	name: string;
	api?: string;
	inputPrice?: number;
	outputPrice?: number;
	cacheReadPrice?: number;
	cacheWritePrice?: number;
} {
	const providerConfig = config?.providers?.[provider];
	const definition = providerConfig?.models?.find((item) => item.id === model);
	return {
		name: definition?.name ?? model,
		api: definition?.api ?? providerConfig?.api,
		inputPrice: definition?.cost?.input,
		outputPrice: definition?.cost?.output,
		cacheReadPrice: definition?.cost?.cacheRead,
		cacheWritePrice: definition?.cost?.cacheWrite,
	};
}

export function formatModelUsageTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString();
}

export function formatSlotLabel(startedAt: number): string {
	const date = new Date(startedAt);
	const startHour = date.getHours();
	const endHour = (startHour + 2) % 24;
	return `${String(startHour).padStart(2, "0")}-${String(endHour).padStart(2, "0")}`;
}

/** 把连续 12 个 2 小时槽位铺满 24h；其他区间按真实 bucket。 */
export function buildOverviewSlots(summary: ModelUsageSummary | null): Array<{
	startedAt: number;
	label: string;
	totalTokens: number;
	totalCost: number;
	requests: number;
	cacheHitRate: number;
	byModel: { key: string; tokens: number; cost: number }[];
}> {
	if (!summary) return [];
	const BUCKET_MS = 2 * 60 * 60 * 1000;
	// 汇总所有模型的 bucket，得到全局槽位表
	const slotMap = new Map<
		number,
		{
			totalTokens: number;
			totalCost: number;
			requests: number;
			cacheRead: number;
			input: number;
			byModel: Map<string, { tokens: number; cost: number }>;
		}
	>();
	for (const model of summary.models) {
		for (const bucket of model.buckets) {
			let slot = slotMap.get(bucket.startedAt);
			if (!slot) {
				slot = { totalTokens: 0, totalCost: 0, requests: 0, cacheRead: 0, input: 0, byModel: new Map() };
				slotMap.set(bucket.startedAt, slot);
			}
			const tokens = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
			slot.totalTokens += tokens;
			slot.totalCost += bucket.costTotal;
			slot.requests += bucket.requests;
			slot.cacheRead += bucket.cacheRead;
			slot.input += bucket.input;
			const key = `${model.provider}/${model.model}`;
			const prev = slot.byModel.get(key) ?? { tokens: 0, cost: 0 };
			prev.tokens += tokens;
			prev.cost += bucket.costTotal;
			slot.byModel.set(key, prev);
		}
	}
	// 24h 视图铺满 12 个槽；其他范围只画有数据的槽
	const slots: Array<{
		startedAt: number;
		label: string;
		totalTokens: number;
		totalCost: number;
		requests: number;
		cacheHitRate: number;
		byModel: { key: string; tokens: number; cost: number }[];
	}> = [];
	if (summary.to - summary.from <= 24 * 60 * 60 * 1000 + BUCKET_MS) {
		const first = Math.floor(summary.from / BUCKET_MS) * BUCKET_MS;
		for (let index = 0; index < 12; index += 1) {
			const startedAt = first + index * BUCKET_MS;
			const slot = slotMap.get(startedAt);
			slots.push({
				startedAt,
				label: formatSlotLabel(startedAt),
				totalTokens: slot?.totalTokens ?? 0,
				totalCost: slot?.totalCost ?? 0,
				requests: slot?.requests ?? 0,
				cacheHitRate: slot && slot.input + slot.cacheRead > 0 ? slot.cacheRead / (slot.input + slot.cacheRead) : 0,
				byModel: slot
					? [...slot.byModel.entries()]
							.map(([key, value]) => ({ key, tokens: value.tokens, cost: value.cost }))
							.sort((a, b) => b.tokens - a.tokens)
					: [],
			});
		}
		return slots;
	}
	return [...slotMap.entries()]
		.sort((left, right) => left[0] - right[0])
		.map(([startedAt, slot]) => ({
			startedAt,
			label: formatSlotLabel(startedAt),
			totalTokens: slot.totalTokens,
			totalCost: slot.totalCost,
			requests: slot.requests,
			cacheHitRate: slot.input + slot.cacheRead > 0 ? slot.cacheRead / (slot.input + slot.cacheRead) : 0,
			byModel: [...slot.byModel.entries()]
				.map(([key, value]) => ({ key, tokens: value.tokens, cost: value.cost }))
				.sort((a, b) => b.tokens - a.tokens),
		}));
}
