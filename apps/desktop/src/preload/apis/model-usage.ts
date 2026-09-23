import type { HostTransport } from "../../shared/host-transport.js";
import type { DesktopApi } from "../api.js";

const SUMMARY_CHANNEL = "vetta:model-usage:summary";
const EXPORT_CSV_CHANNEL = "vetta:model-usage:export-csv";
const BACKFILL_COST_CHANNEL = "vetta:model-usage:backfill-cost";

export function createModelUsageApi(ipc: HostTransport): Pick<DesktopApi, "modelUsage"> {
	return {
		modelUsage: {
			summary: (query) => ipc.invoke(SUMMARY_CHANNEL, query),
			exportCsv: (query) => ipc.invoke(EXPORT_CSV_CHANNEL, query),
			backfillCost: (query) => ipc.invoke(BACKFILL_COST_CHANNEL, query),
		},
	};
}
