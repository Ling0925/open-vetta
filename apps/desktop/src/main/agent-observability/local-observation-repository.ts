import { readFile, stat } from "node:fs/promises";
import { parseRuntimeTraceRecord, type RuntimeTraceRecord, traceObject } from "@vetta/runtime-telemetry";
import { atomicWriteJSONAsync } from "@vetta/toolkit/atomic-write";
import type {
	AgentObservationHealth,
	AgentObservationModelSummary,
	AgentObservationPage,
	AgentObservationSummary,
	AgentObservationSummaryBucket,
} from "./contracts.js";
import { parseAgentObservationQuery, parseAgentObservationSummaryQuery } from "./observation-query.js";
import { correlateAgentTraces } from "./trace-correlation.js";

export interface LocalAgentObservationRepositoryOptions {
	readonly path: string;
	readonly now?: () => number;
	readonly maxRecords?: number;
	readonly retentionMs?: number;
	readonly maxBytes?: number;
	readonly write?: (path: string, value: unknown) => Promise<void>;
	readonly onIssue?: (code: NonNullable<AgentObservationHealth["issue"]>) => void;
}

/** Single owner of a bounded, atomically checkpointed diagnostic file. No execution awaits disk writes. */
export class LocalAgentObservationRepository {
	private readonly records = new Map<string, RuntimeTraceRecord>();
	private readonly now: () => number;
	private readonly maxRecords: number;
	private readonly retentionMs: number;
	private readonly maxBytes: number;
	private timer?: ReturnType<typeof setTimeout>;
	private loaded = false;
	private dirty = false;
	private dropped = 0;
	private issue: AgentObservationHealth["issue"] = null;
	private tail: Promise<void> = Promise.resolve();
	constructor(private readonly options: LocalAgentObservationRepositoryOptions) {
		this.now = options.now ?? Date.now;
		this.maxRecords = options.maxRecords ?? 5000;
		this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	}
	append(record: RuntimeTraceRecord): void {
		const safe = parseRuntimeTraceRecord(record);
		if (!safe) {
			this.reportIssue("TRACE_FORMAT_INVALID");
			return;
		}
		this.records.set(safe.id, safe);
		this.dirty = true;
		this.prune();
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, 500);
			this.timer.unref();
		}
	}
	reportIssue(code: NonNullable<AgentObservationHealth["issue"]>): void {
		const previous = this.issue;
		this.issue = code;
		if (code === "TRACE_CAPACITY") this.dropped++;
		if (previous !== code)
			try {
				this.options.onIssue?.(code);
			} catch {
				/* Logging is best effort. */
			}
	}
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const task = this.tail.then(() => this.checkpoint());
		this.tail = task.catch(() => this.reportIssue("TRACE_STORAGE_FAILED"));
		return this.tail;
	}
	async query(input: unknown): Promise<AgentObservationPage> {
		const query = parseAgentObservationQuery(input);
		await this.flush();
		this.prune();
		const records = correlateAgentTraces([...this.records.values()])
			.filter(
				(record) =>
					record.context.sessionId === query.sessionId &&
					(!query.turnId || record.context.turnId === query.turnId) &&
					(!query.traceId || record.traceId === query.traceId) &&
					(!query.errorsOnly || record.state === "error" || record.state === "interrupted"),
			)
			.sort(newestFirst)
			.filter((record) => !query.cursor || beforeCursor(record, query.cursor));
		const page = records.slice(0, query.limit ?? 100);
		const last = page.at(-1);
		return {
			records: page,
			nextCursor: records.length > page.length && last ? `${last.startedAt}:${last.id}` : null,
			health: { records: this.records.size, dropped: this.dropped, issue: this.issue },
		};
	}
	async summarize(input: unknown): Promise<AgentObservationSummary> {
		const query = parseAgentObservationSummaryQuery(input);
		await this.flush();
		this.prune();
		const models = new Map<string, MutableModelSummary>();
		const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
		for (const record of correlateAgentTraces([...this.records.values()])) {
			if (record.kind !== "generation") continue;
			if (record.startedAt < query.from || record.startedAt >= query.to) continue;
			if (query.sessionId && record.context.sessionId !== query.sessionId) continue;
			const provider = typeof record.metadata.provider === "string" ? record.metadata.provider : "";
			const modelId = typeof record.metadata.model === "string" ? record.metadata.model : record.name;
			const api = typeof record.metadata.api === "string" ? record.metadata.api : "";
			const modelKey = `${provider}/${modelId}`;
			let model = models.get(modelKey);
			if (!model) {
				model = {
					model: modelId,
					provider,
					api,
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
			const usage = record.usage;
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
			const costTotal = record.cost.total ?? 0;
			const durationMs = record.endedAt !== undefined ? Math.max(0, record.endedAt - record.startedAt) : 0;
			model.requests += 1;
			if (record.state === "error" || record.state === "interrupted") model.errors += 1;
			model.input += input;
			model.output += output;
			model.cacheRead += cacheRead;
			model.cacheWrite += cacheWrite;
			model.totalTokens += totalTokens;
			model.costTotal += costTotal;
			model.totalDurationMs += durationMs;
			model.maxDurationMs = Math.max(model.maxDurationMs, durationMs);
			totals.requests += 1;
			totals.input += input;
			totals.output += output;
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			totals.totalTokens += totalTokens;
			totals.costTotal += costTotal;
			const bucketStart = record.startedAt - (record.startedAt % SUMMARY_BUCKET_MS);
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
			if (record.state === "error" || record.state === "interrupted") bucket.errors += 1;
			bucket.input += input;
			bucket.output += output;
			bucket.cacheRead += cacheRead;
			bucket.cacheWrite += cacheWrite;
			bucket.costTotal += costTotal;
		}
		return {
			...totals,
			models: [...models.values()].map(finalizeModelSummary).sort((left, right) => right.costTotal - left.costTotal),
			health: { records: this.records.size, dropped: this.dropped, issue: this.issue },
		};
	}
	private async checkpoint(): Promise<void> {
		if (!this.loaded && !(await this.load())) return;
		this.prune();
		if (!this.dirty) return;
		let document = this.document();
		while (Buffer.byteLength(JSON.stringify(document, null, 2), "utf8") > this.maxBytes && this.records.size > 0) {
			const oldest = [...this.records.values()]
				.sort(newestFirst)
				.slice(Math.max(0, Math.floor(this.records.size * 0.8)));
			for (const record of oldest) {
				this.records.delete(record.id);
				this.dropped++;
			}
			document = this.document();
		}
		this.dirty = false;
		try {
			await (this.options.write ?? atomicWriteJSONAsync)(this.options.path, document);
			if (this.issue === "TRACE_STORAGE_FAILED") this.issue = null;
		} catch {
			this.dirty = true;
			this.reportIssue("TRACE_STORAGE_FAILED");
		}
	}
	private async load(): Promise<boolean> {
		try {
			const info = await stat(this.options.path);
			if (info.size > this.maxBytes) {
				this.reportIssue("TRACE_FORMAT_INVALID");
				return false;
			}
			const text = await readFile(this.options.path, "utf8");
			if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
				this.reportIssue("TRACE_FORMAT_INVALID");
				return false;
			}
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch {
				this.reportIssue("TRACE_FORMAT_INVALID");
				return false;
			}
			const document = traceObject(value);
			if (
				!document ||
				document.schemaVersion !== 1 ||
				!Array.isArray(document.records) ||
				document.records.length > this.maxRecords
			) {
				this.reportIssue("TRACE_FORMAT_INVALID");
				return false;
			}
			const parsed = document.records.map(parseRuntimeTraceRecord);
			if (parsed.some((record) => !record) || new Set(parsed.map((record) => record?.id)).size !== parsed.length) {
				this.reportIssue("TRACE_FORMAT_INVALID");
				return false;
			}
			for (const record of parsed)
				if (record && !this.records.has(record.id)) {
					this.records.set(record.id, record.state === "running" ? { ...record, state: "interrupted" } : record);
					if (record.state === "running") this.dirty = true;
				}
			if (typeof document.dropped === "number" && Number.isSafeInteger(document.dropped) && document.dropped >= 0)
				this.dropped += document.dropped;
			this.loaded = true;
			if (this.issue === "TRACE_STORAGE_FAILED" || this.issue === "TRACE_FORMAT_INVALID") this.issue = null;
			return true;
		} catch (error) {
			if (traceObject(error)?.code === "ENOENT") {
				this.loaded = true;
				return true;
			}
			this.reportIssue("TRACE_STORAGE_FAILED");
			return false;
		}
	}
	private document() {
		return { schemaVersion: 1, records: [...this.records.values()], dropped: this.dropped };
	}
	private prune(): void {
		for (const record of this.records.values())
			if (record.startedAt < this.now() - this.retentionMs) {
				this.records.delete(record.id);
				this.dirty = true;
			}
		const excess = [...this.records.values()].sort(newestFirst).slice(this.maxRecords);
		for (const record of excess) {
			this.records.delete(record.id);
			this.dropped++;
			this.dirty = true;
		}
	}
}
/** 时段图固定 2 小时一格，与用量页横轴一致。 */
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
	model: string;
	provider: string;
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

function finalizeModelSummary(model: MutableModelSummary): AgentObservationModelSummary {
	const buckets: AgentObservationSummaryBucket[] = [...model.buckets.values()].sort(
		(left, right) => left.startedAt - right.startedAt,
	);
	return {
		model: model.model,
		provider: model.provider,
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
		buckets,
	};
}

function newestFirst(left: RuntimeTraceRecord, right: RuntimeTraceRecord): number {
	return right.startedAt - left.startedAt || right.id.localeCompare(left.id);
}
function beforeCursor(record: RuntimeTraceRecord, cursor: string): boolean {
	const separator = cursor.indexOf(":");
	const timestamp = Number(cursor.slice(0, separator));
	return (
		record.startedAt < timestamp ||
		(record.startedAt === timestamp && record.id.localeCompare(cursor.slice(separator + 1)) < 0)
	);
}
