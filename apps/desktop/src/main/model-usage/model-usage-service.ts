import { getAppLogger } from "../logger.js";
import { getDesktopModelSettingsService } from "../models/model-settings-host.js";
import type { ModelUsageLedger } from "./usage-ledger.js";
import type { ModelUsageRecord } from "./usage-record.js";

const log = getAppLogger("model-usage");

export interface ModelUsageSummaryBucket {
	readonly startedAt: number;
	readonly requests: number;
	readonly errors: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costTotal: number;
}

export interface ModelUsageModelSummary {
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly requests: number;
	readonly errors: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	readonly totalDurationMs: number;
	readonly maxDurationMs: number;
	readonly outputSpeed: number;
	readonly buckets: readonly ModelUsageSummaryBucket[];
}

export interface ModelUsageSummary {
	readonly from: number;
	readonly to: number;
	readonly requests: number;
	readonly errors: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	readonly models: readonly ModelUsageModelSummary[];
}

const SUMMARY_BUCKET_MS = 2 * 60 * 60 * 1000;

interface MutableBucket {
	startedAt: number;
	requests: number;
	errors: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
}

interface MutableModelSummary {
	provider: string;
	model: string;
	api: string;
	requests: number;
	errors: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
	totalDurationMs: number;
	maxDurationMs: number;
	buckets: Map<number, MutableBucket>;
}

export function summarizeModelUsageRecords(records: readonly ModelUsageRecord[]): ModelUsageSummary {
	const models = new Map<string, MutableModelSummary>();
	const totals = {
		requests: 0,
		errors: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costTotal: 0,
	};
	let min = Number.POSITIVE_INFINITY;
	let max = 0;
	for (const record of records) {
		min = Math.min(min, record.at);
		max = Math.max(max, record.endedAt ?? record.at);
		const modelKey = `${record.provider}/${record.model}`;
		let model = models.get(modelKey);
		if (!model) {
			model = {
				provider: record.provider,
				model: record.model,
				api: record.api ?? "",
				requests: 0,
				errors: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				costTotal: 0,
				totalDurationMs: 0,
				maxDurationMs: 0,
				buckets: new Map<number, MutableBucket>(),
			};
			models.set(modelKey, model);
		}
		const input = record.input;
		const output = record.output;
		const cacheRead = record.cacheRead;
		const cacheWrite = record.cacheWrite;
		const totalTokens = input + output + cacheRead + cacheWrite;
		const durationMs = record.durationMs ?? 0;
		model.requests += 1;
		if (record.state !== "completed") model.errors += 1;
		model.input += input;
		model.output += output;
		model.cacheRead += cacheRead;
		model.cacheWrite += cacheWrite;
		model.totalTokens += totalTokens;
		model.costTotal += record.costTotal;
		model.totalDurationMs += durationMs;
		model.maxDurationMs = Math.max(model.maxDurationMs, durationMs);
		totals.requests += 1;
		if (record.state !== "completed") totals.errors += 1;
		totals.input += input;
		totals.output += output;
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.totalTokens += totalTokens;
		totals.costTotal += record.costTotal;
		const bucketStart = record.at - (record.at % SUMMARY_BUCKET_MS);
		let bucket = model.buckets.get(bucketStart);
		if (!bucket) {
			bucket = {
				startedAt: bucketStart,
				requests: 0,
				errors: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				costTotal: 0,
			};
			model.buckets.set(bucketStart, bucket);
		}
		bucket.requests += 1;
		if (record.state !== "completed") bucket.errors += 1;
		bucket.input += input;
		bucket.output += output;
		bucket.cacheRead += cacheRead;
		bucket.cacheWrite += cacheWrite;
		bucket.costTotal += record.costTotal;
	}
	return {
		from: Number.isFinite(min) ? min : 0,
		to: max,
		...totals,
		models: [...models.values()].map(finalizeModelSummary).sort((left, right) => right.costTotal - left.costTotal),
	};
}

function finalizeModelSummary(model: MutableModelSummary): ModelUsageModelSummary {
	return {
		provider: model.provider,
		model: model.model,
		api: model.api,
		requests: model.requests,
		errors: model.errors,
		input: model.input,
		output: model.output,
		cacheRead: model.cacheRead,
		cacheWrite: model.cacheWrite,
		totalTokens: model.totalTokens,
		costTotal: model.costTotal,
		totalDurationMs: model.totalDurationMs,
		maxDurationMs: model.maxDurationMs,
		outputSpeed: model.totalDurationMs > 0 ? model.output / (model.totalDurationMs / 1000) : 0,
		buckets: [...model.buckets.values()].sort((left, right) => left.startedAt - right.startedAt),
	};
}

export interface ModelUsageQuery {
	readonly from: number;
	readonly to: number;
	readonly sessionId?: string;
}

export interface ModelUsageCostBackfillResult {
	readonly updated: number;
}

/**
 * 模型用量领域服务：读账本、汇总、回填成本。
 * 单价来源是 models.json（`cost` 字段，单位 USD/1M tokens）。
 */
export class ModelUsageService {
	constructor(private readonly ledger: ModelUsageLedger) {}

	async summary(query: ModelUsageQuery): Promise<ModelUsageSummary> {
		const records = await this.ledger.read({ from: query.from, to: query.to });
		const filtered = query.sessionId ? records.filter((record) => record.sessionId === query.sessionId) : records;
		return { ...summarizeModelUsageRecords(filtered), from: query.from, to: query.to };
	}

	/** 按当前 models.json 单价重算 [from, to) 范围内的 costTotal。 */
	async backfillCost(query: ModelUsageQuery): Promise<ModelUsageCostBackfillResult> {
		const config = await getDesktopModelSettingsService().getConfig();
		const priceMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			for (const model of provider.models ?? []) {
				if (!model.cost) continue;
				priceMap.set(`${providerId}/${model.id}`, {
					input: model.cost.input,
					output: model.cost.output,
					cacheRead: model.cost.cacheRead,
					cacheWrite: model.cost.cacheWrite,
				});
			}
		}
		const updated = await this.ledger.rewrite({ from: query.from, to: query.to }, (record) => {
			const price = priceMap.get(`${record.provider}/${record.model}`);
			if (!price) return record;
			const costTotal =
				(record.input * price.input +
					record.output * price.output +
					record.cacheRead * price.cacheRead +
					record.cacheWrite * price.cacheWrite) /
				1_000_000;
			if (Math.abs(costTotal - record.costTotal) < 1e-9) return record;
			return { ...record, costTotal };
		});
		log.info(
			`backfill cost updated ${updated} records in [${new Date(query.from).toISOString()}, ${new Date(query.to).toISOString()})`,
		);
		return { updated };
	}
}

let modelUsageService: ModelUsageService | undefined;

export function getModelUsageService(ledger: ModelUsageLedger): ModelUsageService {
	if (!modelUsageService) {
		modelUsageService = new ModelUsageService(ledger);
	}
	return modelUsageService;
}
