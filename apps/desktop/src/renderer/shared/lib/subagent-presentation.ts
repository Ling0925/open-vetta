import type { SubagentTask } from "@shared/store/atoms";
import type { TFunction } from "i18next";

export interface SubagentErrorPresentation {
	readonly label: string;
	readonly detail: string;
}

export function subagentObjective(task: string): string {
	const match = task.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/u);
	return (match?.[1] ?? task).trim();
}

export function subagentUsageLabel(usage: SubagentTask["usage"], t: TFunction<"chat">): string {
	if (!usage) return "";
	const tokens = usage.input + usage.output;
	if (tokens === 0 && usage.costTotal === 0) return "";
	return t("activityPanel.subagents.usage", {
		tokens: compactNumber(tokens),
		cost: usage.costTotal.toLocaleString(undefined, {
			style: "currency",
			currency: "USD",
			minimumFractionDigits: usage.costTotal < 0.01 ? 3 : 2,
			maximumFractionDigits: usage.costTotal < 0.01 ? 3 : 2,
		}),
	});
}

export function subagentErrorPresentation(
	errorMessage: string | undefined,
	t: TFunction<"chat">,
): SubagentErrorPresentation | undefined {
	if (!errorMessage?.trim()) return undefined;
	const normalized = errorMessage.toLowerCase();
	const label = normalized.match(/permission|denied|unauthorized|forbidden/u)
		? t("activityPanel.subagents.errorPermission")
		: normalized.match(/context|token|maximum length|too long/u)
			? t("activityPanel.subagents.errorContext")
			: normalized.match(/network|timeout|timed out|connection|unavailable/u)
				? t("activityPanel.subagents.errorConnection")
				: t("activityPanel.subagents.errorExecution");
	return { label, detail: clipText(errorMessage.trim(), 360) };
}

function compactNumber(value: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function clipText(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}


export function subagentTypeLabel(agentType: string, t: TFunction<"chat">): string {
	switch (agentType) {
		case "advisor":
			return t("activityPanel.subagents.types.advisor");
		case "explorer":
			return t("activityPanel.subagents.types.explorer");
		case "general":
			return t("activityPanel.subagents.types.general");
		case "workflow":
			return t("activityPanel.subagents.types.workflow");
		default:
			return agentType;
	}
}

export function subagentDurationLabel(
	startedAt: number,
	endedAt: number | undefined,
	now: number,
	t: TFunction<"chat">,
): string {
	const ms = Math.max(0, (endedAt ?? now) - startedAt);
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return t("activityPanel.backgroundTasks.durationSec", { sec });
	const min = Math.floor(sec / 60);
	if (min < 60) return t("activityPanel.backgroundTasks.durationMin", { min, sec: sec % 60 });
	const hr = Math.floor(min / 60);
	return t("activityPanel.backgroundTasks.durationHour", { hr, min: min % 60 });
}

export function subagentResultPreview(value: string | undefined, limit = 640): string | undefined {
	if (!value?.trim()) return undefined;
	const normalized = value.trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
