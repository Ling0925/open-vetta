import { dialog, ipcMain } from "electron";
import { modelUsageRecordsToCsv } from "../model-usage/model-usage-export.js";
import { getModelUsageService } from "../model-usage/model-usage-service.js";
import { getModelUsageLedger } from "../model-usage/usage-ledger.js";

const SUMMARY_CHANNEL = "vetta:model-usage:summary";
const EXPORT_CSV_CHANNEL = "vetta:model-usage:export-csv";
const BACKFILL_COST_CHANNEL = "vetta:model-usage:backfill-cost";

interface ModelUsageQueryInput {
	readonly from?: unknown;
	readonly to?: unknown;
	readonly sessionId?: unknown;
}

function parseQuery(value: unknown): { from: number; to: number; sessionId?: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("MODEL_USAGE_QUERY_INVALID");
	const input = value as ModelUsageQueryInput;
	const from = typeof input.from === "number" && Number.isFinite(input.from) && input.from >= 0 ? input.from : null;
	const to = typeof input.to === "number" && Number.isFinite(input.to) && input.to >= 0 ? input.to : null;
	if (from === null || to === null || to <= from) throw new Error("MODEL_USAGE_QUERY_INVALID");
	const sessionId =
		typeof input.sessionId === "string" && input.sessionId.trim() !== ""
			? input.sessionId.trim().slice(0, 128)
			: undefined;
	return { from, to, ...(sessionId ? { sessionId } : {}) };
}

function csvFileName(from: number, to: number): string {
	const format = (timestamp: number) => {
		const date = new Date(timestamp);
		return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
	};
	return `vetta-model-usage-${format(from)}-${format(to)}.csv`;
}

export function registerModelUsageIpc(): () => void {
	ipcMain.handle(SUMMARY_CHANNEL, async (_event, payload: unknown) => {
		const query = parseQuery(payload);
		return getModelUsageService(getModelUsageLedger()).summary(query);
	});
	ipcMain.handle(EXPORT_CSV_CHANNEL, async (_event, payload: unknown) => {
		const query = parseQuery(payload);
		const ledger = getModelUsageLedger();
		const records = await ledger.read({ from: query.from, to: query.to });
		const filtered = query.sessionId ? records.filter((record) => record.sessionId === query.sessionId) : records;
		const result = await dialog.showSaveDialog({
			title: "导出模型用量 CSV",
			defaultPath: csvFileName(query.from, query.to),
			filters: [{ name: "CSV", extensions: ["csv"] }],
		});
		if (result.canceled || !result.filePath) return null;
		const { writeModelUsageCsv } = await import("../model-usage/model-usage-export.js");
		await writeModelUsageCsv(result.filePath, filtered);
		return { path: result.filePath, count: filtered.length, preview: modelUsageRecordsToCsv(filtered.slice(0, 5)) };
	});
	ipcMain.handle(BACKFILL_COST_CHANNEL, async (_event, payload: unknown) => {
		const query = parseQuery(payload);
		return getModelUsageService(getModelUsageLedger()).backfillCost(query);
	});
	return () => {
		ipcMain.removeHandler(SUMMARY_CHANNEL);
		ipcMain.removeHandler(EXPORT_CSV_CHANNEL);
		ipcMain.removeHandler(BACKFILL_COST_CHANNEL);
	};
}
