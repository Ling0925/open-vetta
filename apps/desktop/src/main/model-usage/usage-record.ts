/**
 * 模型用量账本：把每次模型调用（含重试）追加为一行 NDJSON 记录。
 *
 * 设计约束（见 app-monitor/AGENTS.md 的旁路原则）：
 * - 写入完全异步、可失败、可丢失，绝不阻塞会话执行；
 * - 只记录聚合指标（token 数、费用、耗时），不记录任何消息内容；
 * - 每月一个文件 `app-monitor/model-usage/YYYY-MM.ndjson`，单文件超阈值滚动一个序号后缀。
 */

export const MODEL_USAGE_SCHEMA_VERSION = 1;

/** 单条模型调用用量。费用单位 USD，token 数为个。 */
export interface ModelUsageRecord {
	readonly schemaVersion: typeof MODEL_USAGE_SCHEMA_VERSION;
	/** 调用开始时间（epoch ms）。 */
	readonly at: number;
	readonly endedAt?: number;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly modelCallId?: string;
	/** models.json 里的 provider key。 */
	readonly provider: string;
	/** 实际模型 id（provider 内）。 */
	readonly model: string;
	/** 接口协议（如 openai-completions）。 */
	readonly api?: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costTotal: number;
	readonly durationMs?: number;
	readonly state: "completed" | "error" | "interrupted";
}

export interface ModelUsageRecordInput {
	readonly at: number;
	readonly endedAt?: number;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly modelCallId?: string;
	readonly provider: string;
	readonly model: string;
	readonly api?: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costTotal: number;
	readonly durationMs?: number;
	readonly state: "completed" | "error" | "interrupted";
}

function normalizeCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeKey(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "__proto__" || trimmed === "prototype" || trimmed === "constructor") return "";
	return trimmed.slice(0, 128);
}

function normalizeAt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeState(value: unknown): ModelUsageRecord["state"] {
	return value === "error" || value === "interrupted" ? value : "completed";
}

/** 宽松解析：任何字段缺失都补默认值；provider/model 缺失时丢弃该记录。 */
export function normalizeModelUsageRecord(value: unknown): ModelUsageRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const provider = normalizeKey(raw.provider);
	const model = normalizeKey(raw.model);
	if (provider === "" || model === "") return null;
	const at = normalizeAt(raw.at);
	if (at === 0) return null;
	const record: ModelUsageRecord = {
		schemaVersion: MODEL_USAGE_SCHEMA_VERSION,
		at,
		provider,
		model,
		input: normalizeCount(raw.input),
		output: normalizeCount(raw.output),
		cacheRead: normalizeCount(raw.cacheRead),
		cacheWrite: normalizeCount(raw.cacheWrite),
		costTotal: normalizeCount(raw.costTotal),
		state: normalizeState(raw.state),
	};
	const endedAt = normalizeAt(raw.endedAt);
	if (endedAt >= at) (record as { endedAt?: number }).endedAt = endedAt;
	const sessionId = normalizeKey(raw.sessionId);
	if (sessionId) (record as { sessionId?: string }).sessionId = sessionId;
	const turnId = normalizeKey(raw.turnId);
	if (turnId) (record as { turnId?: string }).turnId = turnId;
	const modelCallId = normalizeKey(raw.modelCallId);
	if (modelCallId) (record as { modelCallId?: string }).modelCallId = modelCallId;
	const api = normalizeKey(raw.api);
	if (api) (record as { api?: string }).api = api;
	const durationMs = normalizeCount(raw.durationMs);
	if (durationMs > 0) (record as { durationMs?: number }).durationMs = durationMs;
	return record;
}

export function toModelUsageRecord(input: ModelUsageRecordInput): ModelUsageRecord | null {
	return normalizeModelUsageRecord({ schemaVersion: MODEL_USAGE_SCHEMA_VERSION, ...input });
}

export function serializeModelUsageRecord(record: ModelUsageRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export function parseModelUsageRecordLine(line: string): ModelUsageRecord | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	try {
		return normalizeModelUsageRecord(JSON.parse(trimmed));
	} catch {
		return null;
	}
}
