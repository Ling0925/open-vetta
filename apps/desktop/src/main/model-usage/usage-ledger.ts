import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVettaHomePath } from "@vetta/action-rpc";
import { getAppLogger } from "../logger.js";
import {
	type ModelUsageRecord,
	type ModelUsageRecordInput,
	parseModelUsageRecordLine,
	serializeModelUsageRecord,
	toModelUsageRecord,
} from "./usage-record.js";

const log = getAppLogger("model-usage");

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
/** 单月分片滚动阈值：超过后追加到 `-1`、`-2` 序号文件。 */
const LEDGER_ROLL_BYTES = 8 * 1024 * 1024;

export interface ModelUsageLedgerOptions {
	readonly rootDir: string;
	readonly now?: () => number;
}

export interface ModelUsageReadRange {
	/** Inclusive start (epoch ms). */
	readonly from: number;
	/** Exclusive end (epoch ms). */
	readonly to: number;
}

/**
 * 追加式 NDJSON 账本。append 只排队、不等待落盘——调用方（会话执行路径）永远不被 IO 阻塞；
 * 失败降级为 warn，不抛出。
 */
export class ModelUsageLedger {
	private readonly rootDir: string;
	private readonly now: () => number;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: ModelUsageLedgerOptions) {
		this.rootDir = options.rootDir;
		this.now = options.now ?? Date.now;
	}

	append(input: ModelUsageRecordInput): void {
		const record = toModelUsageRecord(input);
		if (!record) return;
		this.tail = this.tail
			.then(() => this.appendUnsafe(record))
			.catch((error: unknown) => {
				log.warn("append failed", error);
			});
	}

	/** 供关闭或月结时等待尾部写入完成。 */
	flush(): Promise<void> {
		return this.tail;
	}

	/** 读取时间范围内的全部记录（跨月自动拼接）。 */
	async read(range: ModelUsageReadRange): Promise<ModelUsageRecord[]> {
		const months = monthKeysInRange(range.from, range.to);
		const records: ModelUsageRecord[] = [];
		for (const month of months) {
			for await (const record of this.readMonth(month)) {
				if (record.at >= range.from && record.at < range.to) records.push(record);
			}
		}
		records.sort((left, right) => left.at - right.at);
		return records;
	}

	/** 读取某个时间范围内已存在的记录并一次性重写（用于回填成本）。 */
	async rewrite(
		range: ModelUsageReadRange,
		transform: (record: ModelUsageRecord) => ModelUsageRecord,
	): Promise<number> {
		const months = monthKeysInRange(range.from, range.to);
		let changed = 0;
		for (const month of months) {
			const files = await this.monthFiles(month);
			for (const filePath of files) {
				const parsed = await this.readFile(filePath);
				if (parsed.length === 0) continue;
				let touched = false;
				const next: ModelUsageRecord[] = [];
				for (const record of parsed) {
					if (record.at >= range.from && record.at < range.to) {
						const updated = transform(record);
						if (updated !== record) {
							touched = true;
							changed += 1;
							next.push(updated);
							continue;
						}
					}
					next.push(record);
				}
				if (touched) await this.writeFileAtomic(filePath, next.map(serializeModelUsageRecord).join(""));
			}
		}
		return changed;
	}

	private async appendUnsafe(record: ModelUsageRecord): Promise<void> {
		const month = monthKeyOf(record.at);
		const dir = join(this.rootDir, month);
		await mkdir(dir, { recursive: true });
		const basePath = join(dir, `${month}.ndjson`);
		let target = basePath;
		for (let index = 0; index < 100; index += 1) {
			target = index === 0 ? basePath : join(dir, `${month}-${index}.ndjson`);
			const size = await fileSize(target);
			if (size < LEDGER_ROLL_BYTES) break;
		}
		await appendFile(target, serializeModelUsageRecord(record), "utf8");
	}

	private async *readMonth(month: string): AsyncGenerator<ModelUsageRecord> {
		const files = await this.monthFiles(month);
		for (const filePath of files) {
			const records = await this.readFile(filePath);
			for (const record of records) {
				yield record;
			}
		}
	}

	private async monthFiles(month: string): Promise<string[]> {
		if (!MONTH_KEY_PATTERN.test(month)) return [];
		const dir = join(this.rootDir, month);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return [];
		}
		return entries
			.filter((name) => name === `${month}.ndjson` || new RegExp(`^${month}-\\d+\\.ndjson$`).test(name))
			.sort()
			.map((name) => join(dir, name));
	}

	private async readFile(filePath: string): Promise<ModelUsageRecord[]> {
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch {
			return [];
		}
		const records: ModelUsageRecord[] = [];
		for (const line of text.split("\n")) {
			const record = parseModelUsageRecordLine(line);
			if (record) records.push(record);
		}
		return records;
	}

	private async writeFileAtomic(filePath: string, content: string): Promise<void> {
		const temporary = `${filePath}.${this.now()}.tmp`;
		await writeFile(temporary, content, "utf8");
		await rm(filePath, { force: true });
		await rename(temporary, filePath);
	}
}

function monthKeyOf(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function monthKeysInRange(from: number, to: number): string[] {
	const keys: string[] = [];
	const cursor = new Date(from);
	cursor.setDate(1);
	cursor.setHours(0, 0, 0, 0);
	while (cursor.getTime() < to) {
		keys.push(monthKeyOf(cursor.getTime()));
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return keys;
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

let modelUsageLedger: ModelUsageLedger | undefined;

export function getModelUsageLedger(): ModelUsageLedger {
	if (!modelUsageLedger) {
		modelUsageLedger = new ModelUsageLedger({ rootDir: modelUsageRootPath() });
	}
	return modelUsageLedger;
}

export function modelUsageRootPath(): string {
	// 与 app-monitor 的 months 同级，沿用同一监控根目录。
	return join(getVettaHomePath(), "app-monitor", "model-usage");
}
