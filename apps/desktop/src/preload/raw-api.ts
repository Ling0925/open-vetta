import type { DesktopHostTransport } from "../shared/host-transport.js";
import type { DesktopApi } from "./api.js";
import { createAbilitiesApi } from "./apis/abilities.js";
import { createActionApprovalApi } from "./apis/action-approval.js";
import { createAgentTeamsApi } from "./apis/agent-teams.js";
import { createAppLifecycleApi } from "./apis/app-lifecycle.js";
import { createAppMonitorApi } from "./apis/app-monitor.js";
import { createAppshotApi } from "./apis/appshot.js";
import { createBatchTasksApi } from "./apis/batch-tasks.js";
import { createConversationTagsApi } from "./apis/conversation-tags.js";
import { createDownloadsApi } from "./apis/downloads.js";
import { createI18nApi } from "./apis/i18n.js";
import { createImApi } from "./apis/im.js";
import { createNotificationApi } from "./apis/notification.js";
import { createPetApi } from "./apis/pet.js";
import { createPluginsApi } from "./apis/plugins.js";
import { createProjectApi } from "./apis/project.js";
import { createQuickPanelApi } from "./apis/quick-panel.js";
import { createRemotePairingApi } from "./apis/remote-pairing.js";
import { createRuntimeConfigurationApi } from "./apis/runtime-configuration.js";
import { createSchedulerApi } from "./apis/scheduler.js";
import { createSessionApi } from "./apis/session.js";
import { createSpeechInputApi } from "./apis/speech-input.js";
import { createSshApi } from "./apis/ssh.js";
import { createSystemApi } from "./apis/system.js";
import { createTelemetryApi } from "./apis/telemetry.js";
import { createTerminalApi } from "./apis/terminal.js";
import { createThemesApi } from "./apis/themes.js";
import { createWebAccessApi } from "./apis/web-access.js";
import { createWebhookApi } from "./apis/webhook.js";

/** Assemble the raw host API without assuming Electron or a particular transport. */
export function createRawDesktopApi(transport: DesktopHostTransport): Omit<DesktopApi, "hostAccess"> {
	const { ipc, filePath } = transport;
	return {
		...createAbilitiesApi(ipc),
		...createAgentTeamsApi(ipc),
		...createActionApprovalApi(ipc),
		...createAppLifecycleApi(ipc),
		...createAppMonitorApi(ipc),
		...createSessionApi(ipc),
		...createSpeechInputApi(ipc),
		...createImApi(ipc),
		...createDownloadsApi(ipc),
		...createBatchTasksApi(ipc),
		...createSchedulerApi(ipc),
		...createWebhookApi(ipc),
		...createNotificationApi(ipc),
		...createPluginsApi(ipc, filePath),
		...createThemesApi(ipc),
		...createPetApi(ipc),
		...createConversationTagsApi(ipc),
		...createProjectApi(ipc),
		...createSshApi(ipc),
		...createTerminalApi(ipc),
		...createQuickPanelApi(ipc),
		...createRuntimeConfigurationApi(ipc),
		remotePairing: createRemotePairingApi(ipc),
		...createAppshotApi(ipc),
		...createI18nApi(ipc),
		...createTelemetryApi(ipc),
		...createSystemApi(ipc, filePath),
		...createWebAccessApi(ipc),
	};
}
