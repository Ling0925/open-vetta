import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelUsageLedger, monthKeysInRange } from "./usage-ledger.js";
import { normalizeModelUsageRecord, parseModelUsageRecordLine } from "./usage-record.js";

const BASE_AT = Date.UTC(2026, 8, 20, 10, 0, 0); // 2026-09-20 10:00 UTC

function recordAt(offsetMs: number) {
	return {
		at: BASE_AT + offsetMs,
		provider: "LingAPI",
		model: "kimi-k3-1",
		api: "openai-completions",
		input: 1000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 0,
		costTotal: 0.005,
		state: "completed" as const,
	};
}

describe("ModelUsageLedger", () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			await rm(directory, { recursive: true, force: true });
		}
	});

	async function createLedger() {
		const rootDir = await mkdtemp(join(tmpdir(), "model-usage-ledger-"));
		directories.push(rootDir);
		return new ModelUsageLedger({ rootDir });
	}

	it("append 后按时间范围读回，并按月分文件", async () => {
		const ledger = await createLedger();
		ledger.append(recordAt(0));
		ledger.append(recordAt(60 * 1000));
		await ledger.flush();

		const month = "2026-09";
		const file = join((ledger as unknown as { rootDir: string }).rootDir, month, `${month}.ndjson`);
		const text = await readFile(file, "utf8");
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = parseModelUsageRecordLine(lines[0]);
		expect(first?.provider).toBe("LingAPI");
		expect(first?.input).toBe(1000);

		const records = await ledger.read({ from: BASE_AT - 1, to: BASE_AT + 120 * 1000 });
		expect(records).toHaveLength(2);
		expect(records[0].at).toBe(BASE_AT);
	});

	it("时间范围过滤：范围外的记录不返回", async () => {
		const ledger = await createLedger();
		ledger.append(recordAt(0));
		ledger.append(recordAt(24 * 60 * 60 * 1000));
		await ledger.flush();
		const records = await ledger.read({ from: BASE_AT - 1, to: BASE_AT + 1000 });
		expect(records).toHaveLength(1);
	});

	it("normalizeModelUsageRecord 丢弃缺 provider/model 的记录", () => {
		expect(normalizeModelUsageRecord({ at: BASE_AT, provider: "", model: "x" })).toBeNull();
		expect(normalizeModelUsageRecord({ at: BASE_AT, provider: "p" })).toBeNull();
		expect(normalizeModelUsageRecord({ at: 0, provider: "p", model: "m" })).toBeNull();
	});

	it("rewrite 只改写范围内的记录并返回改写数", async () => {
		const ledger = await createLedger();
		ledger.append(recordAt(0));
		ledger.append(recordAt(24 * 60 * 60 * 1000));
		await ledger.flush();
		const updated = await ledger.rewrite({ from: BASE_AT - 1, to: BASE_AT + 1000 }, (record) => ({
			...record,
			costTotal: 0.01,
		}));
		expect(updated).toBe(1);
		const records = await ledger.read({ from: BASE_AT - 1, to: BASE_AT + 48 * 60 * 60 * 1000 });
		expect(records.find((record) => record.at === BASE_AT)?.costTotal).toBe(0.01);
		expect(records.find((record) => record.at !== BASE_AT)?.costTotal).toBe(0.005);
	});

	it("monthKeysInRange 跨月拼接", () => {
		const from = Date.UTC(2026, 7, 15); // 2026-08-15
		const to = Date.UTC(2026, 9, 2); // 2026-10-02
		expect(monthKeysInRange(from, to)).toEqual(["2026-08", "2026-09", "2026-10"]);
	});
});
