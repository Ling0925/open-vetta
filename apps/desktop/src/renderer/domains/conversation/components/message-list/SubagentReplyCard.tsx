import {
	subagentErrorPresentation,
	subagentObjective,
	subagentResultPreview,
	subagentTypeLabel,
	subagentUsageLabel,
} from "@shared/lib/subagent-presentation";
import type { SubagentTask } from "@shared/store/subagents-atoms";
import { isSubagentActive, workflowDisplayName } from "@shared/store/subagents-atoms";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function SubagentReplyCard({ task }: { task: SubagentTask }): JSX.Element {
	const { t } = useTranslation("chat");
	const navigate = useNavigate();
	const name = workflowDisplayName(task);
	const canOpen = Boolean(task.sessionFile);
	const active = isSubagentActive(task.status);
	const objective = subagentObjective(task.task);
	const usage = subagentUsageLabel(task.usage, t);
	const error = subagentErrorPresentation(task.errorMessage, t);
	const result = subagentResultPreview(task.finalText, 360);
	const typeLabel = subagentTypeLabel(task.agentType, t);
	const icon =
		task.agentType === "advisor"
			? "icon-[solar--chat-round-line-linear]"
			: task.agentType === "explorer"
				? "icon-[solar--magnifer-linear]"
				: "icon-[solar--users-group-rounded-linear]";

	return (
		<div
			data-testid="subagent-reply-card"
			className="min-w-0 rounded-xl border border-border/40 bg-secondary px-3 py-2.5 dark:bg-input-bar-bg"
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className={`${icon} h-4 w-4 shrink-0 text-primary`} aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<div className="truncate text-[13px] font-semibold text-foreground/90">{name}</div>
						<span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
							{typeLabel}
						</span>
					</div>
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
						<span>{t(`subagentCard.status.${task.status}`)}</span>
						{task.todoProgress?.total ? (
							<span className="font-mono tabular-nums">
								{task.todoProgress.done}/{task.todoProgress.total}
							</span>
						) : null}
						{usage ? <span>{usage}</span> : null}
					</div>
				</div>
				{active ? (
					<button
						type="button"
						aria-label={t("subagentCard.stop", { name })}
						title={t("subagentCard.stop", { name })}
						onClick={() => void window.vetta.session.interruptSubagent(task.parentSessionId, task.id)}
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<span className="icon-[solar--stop-circle-linear] h-4 w-4" aria-hidden="true" />
					</button>
				) : null}
				<button
					type="button"
					disabled={!canOpen}
					aria-label={t("subagentCard.open", { name })}
					title={canOpen ? t("subagentCard.open", { name }) : t("subagentCard.waitingForSession")}
					onClick={() => {
						if (task.sessionFile) {
							void navigate({
								to: "/viewer/$path",
								params: { path: encodeURIComponent(task.sessionFile) },
								search: { origin: "subagent" },
							});
						}
					}}
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
				>
					<span className="icon-[solar--arrow-right-up-linear] h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			{objective ? (
				<div className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-foreground/85" title={objective}>
					{objective}
				</div>
			) : null}
			{error ? (
				<div className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive">
					<div className="font-medium">{error.label}</div>
					<div className="mt-0.5 line-clamp-2 break-words">{error.detail}</div>
				</div>
			) : result ? (
				<div className="mt-2 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
					{result}
				</div>
			) : null}
		</div>
	);
}
