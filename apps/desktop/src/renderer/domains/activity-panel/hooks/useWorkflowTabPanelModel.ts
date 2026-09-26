import {
	subagentDurationLabel,
	subagentErrorPresentation,
	subagentObjective,
	subagentResultPreview,
	subagentUsageLabel,
} from "@shared/lib/subagent-presentation";
import { workflowProgressLabel, workflowStatusMeta } from "@shared/lib/workflow-status";
import {
	type ChatConversationItem,
	getSubagentsForSession,
	isSubagentActive,
	isWorkflowTask,
	type SubagentTask,
	selectedWorkflowIdAtom,
	subagentsBySessionAtom,
	workflowDisplayName,
} from "@shared/store/atoms";
import type { WorkflowSwitcherItem } from "@vetta-org/theme-ui/activity";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fullHistoryToChat } from "../../conversation/services/chat-service";
import { useActivityRuntimeIds } from "../registry/context";
import { collectRuntimeScoped } from "../services/runtime-scope";

export interface WorkflowTabPanelModel {
	items: WorkflowSwitcherItem[];
	selected: SubagentTask | null;
	messages: ChatConversationItem[];
	emptyLabel: string;
	stopLabel: string;
	noTranscriptLabel: string;
	overallLabel: string;
	followUpLabel: string;
	followUpPlaceholder: string;
	followUpSendLabel: string;
	followUpFailedLabel: string;
	onSelect: (id: string) => void;
	onStop: (id: string) => void;
	onFollowUp: (id: string, message: string) => Promise<boolean>;
}

export function useWorkflowTabPanelModel(): WorkflowTabPanelModel {
	const { t } = useTranslation("chat");
	const runtimeIds = useActivityRuntimeIds();
	const subagentsMap = useAtomValue(subagentsBySessionAtom);
	const [selectedId, setSelectedId] = useAtom(selectedWorkflowIdAtom);
	const [messages, setMessages] = useState<ChatConversationItem[]>([]);

	// Workspaces that aggregate several runtimes (Team) need each workflow's owning
	// runtime to route the interrupt back to the member that spawned it.
	const scoped = useMemo(
		() =>
			collectRuntimeScoped(runtimeIds, (runtimeId) =>
				getSubagentsForSession(subagentsMap, runtimeId).filter(isWorkflowTask),
			),
		[subagentsMap, runtimeIds],
	);
	const workflows = useMemo(() => scoped.map((row) => row.item), [scoped]);
	const runtimeIdByWorkflowId = useMemo(() => new Map(scoped.map((row) => [row.item.id, row.runtimeId])), [scoped]);

	const selected = useMemo(() => {
		if (selectedId) {
			const match = workflows.find((w) => w.id === selectedId);
			if (match) return match;
		}
		return workflows.find((w) => isSubagentActive(w.status)) ?? workflows[0] ?? null;
	}, [workflows, selectedId]);

	const hasActiveWorkflow = workflows.some((workflow) => isSubagentActive(workflow.status));
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!hasActiveWorkflow) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasActiveWorkflow]);

	const items = useMemo(
		() =>
			workflows.map((task) => {
				const meta = workflowStatusMeta(task.status, t);
				const error = subagentErrorPresentation(task.errorMessage, t);
				return {
					id: task.id,
					name: workflowDisplayName(task),
					progressLabel: workflowProgressLabel(task),
					statusLabel: meta.label,
					statusIcon: meta.icon,
					statusClassName: meta.className,
					objective: subagentObjective(task.task),
					usageLabel: subagentUsageLabel(task.usage, t),
					durationLabel: subagentDurationLabel(task.startedAt, task.endedAt, now, t),
					summary: subagentResultPreview(task.finalText),
					errorLabel: error?.label,
					errorDetail: error?.detail,
					selected: task.id === selected?.id,
					active: isSubagentActive(task.status),
				};
			}),
		[workflows, selected?.id, now, t],
	);

	// Read-only live transcript: reuse the no-lock session viewer channel on the
	// child's own jsonl (fs-watch pushes fresh snapshots while the child runs).
	const sessionFile = selected?.sessionFile;
	useEffect(() => {
		setMessages([]);
		if (!sessionFile) return;
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;

		(async () => {
			try {
				const initial = await window.vetta.session.openViewer(sessionFile);
				if (cancelled) return;
				setMessages(fullHistoryToChat(initial.history));
				unsubscribe = await window.vetta.session.subscribeViewer(sessionFile, (snapshot) => {
					setMessages(fullHistoryToChat(snapshot.history));
				});
				if (cancelled) unsubscribe?.();
			} catch {
				// Child file may not exist yet (queued / just spawning); keep empty state.
			}
		})();

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [sessionFile]);

	const onSelect = useCallback((id: string) => setSelectedId(id), [setSelectedId]);
	const onFollowUp = useCallback(
		async (id: string, message: string): Promise<boolean> => {
			const runtimeId = runtimeIdByWorkflowId.get(id);
			if (!runtimeId) return false;
			try {
				return await window.vetta.session.followUpSubagent(runtimeId, id, message);
			} catch (error) {
				console.error("[WorkflowTabPanel] workflow follow-up failed", error);
				return false;
			}
		},
		[runtimeIdByWorkflowId],
	);

	const onStop = useCallback(
		(id: string) => {
			const runtimeId = runtimeIdByWorkflowId.get(id);
			if (!runtimeId) return;
			void window.vetta.session.interruptSubagent?.(runtimeId, id);
		},
		[runtimeIdByWorkflowId],
	);

	return {
		items,
		selected,
		messages,
		emptyLabel: t("activityPanel.workflow.empty"),
		stopLabel: t("activityPanel.workflow.stop"),
		noTranscriptLabel: t("activityPanel.workflow.noTranscript"),
		overallLabel: t("activityPanel.workflow.overall", {
			done: workflows.filter((workflow) => !isSubagentActive(workflow.status)).length,
			total: workflows.length,
			active: workflows.filter((workflow) => isSubagentActive(workflow.status)).length,
		}),
		followUpLabel: t("activityPanel.workflow.followUp"),
		followUpPlaceholder: t("activityPanel.workflow.followUpPlaceholder"),
		followUpSendLabel: t("activityPanel.workflow.followUpSend"),
		followUpFailedLabel: t("activityPanel.workflow.followUpFailed"),
		onSelect,
		onStop,
		onFollowUp,
	};
}
