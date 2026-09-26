import { BackgroundTasksTabPanelView } from "@vetta-org/theme-ui/activity";
import { useBackgroundTasksTabPanelModel } from "../hooks/useBackgroundTasksTabPanelModel";

export function BackgroundTasksTabPanel(): JSX.Element {
	const model = useBackgroundTasksTabPanelModel();

	return (
		<BackgroundTasksTabPanelView
			items={model.items}
			emptyLabel={model.emptyLabel}
			clearFinishedLabel={model.clearFinishedLabel}
			onClearFinished={model.onClearFinished}
			stopLabel={model.stopLabel}
			openLabel={model.openLabel}
			followUpLabel={model.followUpLabel}
			followUpPlaceholder={model.followUpPlaceholder}
			followUpSendLabel={model.followUpSendLabel}
			followUpFailedLabel={model.followUpFailedLabel}
			onStop={model.onStop}
			onOpenSubagent={model.onOpenSubagent}
			onFollowUpSubagent={model.onFollowUpSubagent}
		/>
	);
}
