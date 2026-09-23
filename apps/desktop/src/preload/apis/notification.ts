import type { HostTransport } from "../../shared/host-transport.js";
import type { DesktopApi } from "../api.js";
import { onIpcEvent } from "./helper.js";

const NOTIFICATION_CHANNELS = {
	SET_FOREGROUND: "vetta:notification:set-foreground-session",
	NAVIGATE: "vetta:notification:navigate",
} as const;

export function createNotificationApi(ipc: HostTransport): Pick<DesktopApi, "notification"> {
	return {
		notification: {
			setForegroundSession: (sessionPath) => ipc.invoke(NOTIFICATION_CHANNELS.SET_FOREGROUND, sessionPath),
			onNavigate: (handler) => onIpcEvent(ipc, NOTIFICATION_CHANNELS.NAVIGATE, handler),
		},
	};
}
