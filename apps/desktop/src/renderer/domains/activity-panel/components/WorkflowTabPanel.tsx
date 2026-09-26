import { MessageList } from "@domains/conversation/components/MessageList";
import { Button } from "@vetta-org/ui";
import { WorkflowTabPanelView } from "@vetta-org/theme-ui/activity";
import { useWorkflowTabPanelModel } from "../hooks/useWorkflowTabPanelModel";
import { useEffect, useState } from "react";
import { useActivityWorkspace } from "../registry/context";

function WorkflowFollowUp({
	id,
	placeholder,
	sendLabel,
	failedLabel,
	onFollowUp,
}: {
	id: string;
	placeholder: string;
	sendLabel: string;
	failedLabel: string;
	onFollowUp: (id: string, message: string) => Promise<boolean>;
}): JSX.Element {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		setDraft("");
		setFailed(false);
	}, [id]);

	const submit = async (): Promise<void> => {
		const message = draft.trim();
		if (!message || sending) return;
		setSending(true);
		setFailed(false);
		try {
			const accepted = await onFollowUp(id, message);
			if (accepted) setDraft("");
			else setFailed(true);
		} catch {
			setFailed(true);
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="rounded-lg border border-border/50 bg-background/45 p-2">
			<textarea
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				placeholder={placeholder}
				rows={2}
				className="w-full resize-none bg-transparent text-[11px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
				onKeyDown={(event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
						event.preventDefault();
						void submit();
					}
				}}
			/>
			<div className="mt-1.5 flex items-center justify-between gap-2">
				<span className="text-[10px] text-destructive">{failed ? failedLabel : null}</span>
				<Button
					type="button"
					variant="secondary"
					size="xs"
					disabled={!draft.trim() || sending}
					onClick={() => void submit()}
					className="h-6 rounded-lg px-2 text-[10px]"
				>
					{sendLabel}
				</Button>
			</div>
		</div>
	);
}

/**
 * Workflow activity tab (ADR-0044): switcher + read-only 1:1 MessageList of
 * the selected workflow child session.
 */
export function WorkflowTabPanel(): JSX.Element {
	const model = useWorkflowTabPanelModel();
	const workspace = useActivityWorkspace();
	return (
		<WorkflowTabPanelView
			items={model.items}
			emptyLabel={model.emptyLabel}
			stopLabel={model.stopLabel}
			noTranscriptLabel={model.noTranscriptLabel}
			hasTranscript={model.messages.length > 0}
			overallLabel={model.overallLabel}
			selectedActions={
				model.selected ? (
					<WorkflowFollowUp
						id={model.selected.id}
						placeholder={model.followUpPlaceholder}
						sendLabel={model.followUpSendLabel}
						failedLabel={model.followUpFailedLabel}
						onFollowUp={model.onFollowUp}
					/>
				) : null
			}
			messageList={
				<MessageList
					messages={model.messages}
					workspace={workspace}
					isStreaming={model.selected?.status === "running"}
					sessionId={model.selected?.sessionFile ?? null}
				/>
			}
			onSelect={model.onSelect}
			onStop={model.onStop}
		/>
	);
}
