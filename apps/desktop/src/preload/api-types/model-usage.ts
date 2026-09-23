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

export interface ModelUsageQuery {
	readonly from: number;
	readonly to: number;
	readonly sessionId?: string;
}

export interface ModelUsageExportCsvResult {
	readonly path: string;
	readonly count: number;
	readonly preview: string;
}

export interface ModelUsageBackfillCostResult {
	readonly updated: number;
}

export interface DesktopModelUsageApi {
	summary(query: ModelUsageQuery): Promise<ModelUsageSummary>;
	exportCsv(query: ModelUsageQuery): Promise<ModelUsageExportCsvResult | null>;
	backfillCost(query: ModelUsageQuery): Promise<ModelUsageBackfillCostResult>;
}
