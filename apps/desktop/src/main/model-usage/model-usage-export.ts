import { writeFile } from "node:fs/promises";
import type { ModelUsageRecord } from "./usage-record.js";

const CSV_HEADER =
	"at,endedAt,sessionId,turnId,modelCallId,provider,model,api,input,output,cacheRead,cacheWrite,costTotal,durationMs,state";

function escapeCsvCell(value: string): string {
	if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
	return value;
}

export function modelUsageRecordsToCsv(records: readonly ModelUsageRecord[]): string {
	const lines = [CSV_HEADER];
	for (const record of records) {
		const cells = [
			new Date(record.at).toISOString(),
			record.endedAt === undefined ? "" : new Date(record.endedAt).toISOString(),
			escapeCsvCell(record.sessionId ?? ""),
			escapeCsvCell(record.turnId ?? ""),
			escapeCsvCell(record.modelCallId ?? ""),
			escapeCsvCell(record.provider),
			escapeCsvCell(record.model),
			escapeCsvCell(record.api ?? ""),
			String(record.input),
			String(record.output),
			String(record.cacheRead),
			String(record.cacheWrite),
			record.costTotal.toFixed(6),
			record.durationMs === undefined ? "" : String(record.durationMs),
			record.state,
		];
		lines.push(cells.join(","));
	}
	return `${lines.join("\n")}\n`;
}

export async function writeModelUsageCsv(path: string, records: readonly ModelUsageRecord[]): Promise<void> {
	await writeFile(path, modelUsageRecordsToCsv(records), "utf8");
}
