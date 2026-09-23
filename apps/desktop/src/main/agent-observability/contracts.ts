import type { RuntimeTraceRecord } from "@vetta/runtime-telemetry";

export interface AgentObservationQuery {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly traceId?: string;
	readonly errorsOnly?: boolean;
	readonly cursor?: string;
	readonly limit?: number;
}
export interface AgentObservationSummaryQuery {
	/** Inclusive start of the aggregation window (epoch ms). */
	readonly from: number;
	/** Exclusive end of the aggregation window (epoch ms). */
	readonly to: number;
	readonly sessionId?: string;
}

export interface AgentObservationSummaryBucket {
	readonly startedAt: number;
	readonly requests: number;
	readonly errors: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costTotal: number;
}

export interface AgentObservationModelSummary {
	readonly model: string;
	readonly provider: string;
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
	readonly buckets: readonly AgentObservationSummaryBucket[];
}

export interface AgentObservationSummary {
	readonly requests: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	readonly models: readonly AgentObservationModelSummary[];
	readonly health: AgentObservationHealth;
}

export interface AgentObservationHealth {
	readonly records: number;
	readonly dropped: number;
	readonly issue: "TRACE_STORAGE_FAILED" | "TRACE_FORMAT_INVALID" | "TRACE_ADAPTER_FAILED" | "TRACE_CAPACITY" | null;
}
export interface AgentObservationPage {
	readonly records: readonly RuntimeTraceRecord[];
	readonly nextCursor: string | null;
	readonly health: AgentObservationHealth;
}
