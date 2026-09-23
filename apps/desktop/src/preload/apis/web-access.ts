import type { HostTransport } from "../../shared/host-transport.js";
import { WEB_ACCESS_CHANNELS } from "../../shared/web-access.js";
import type { DesktopApi } from "../api.js";

export function createWebAccessApi(ipc: HostTransport): Pick<DesktopApi, "webAccess"> {
	return {
		webAccess: {
			getState: () => ipc.invoke(WEB_ACCESS_CHANNELS.GET_STATE),
			configure: (config) => ipc.invoke(WEB_ACCESS_CHANNELS.CONFIGURE, config),
			enable: () => ipc.invoke(WEB_ACCESS_CHANNELS.ENABLE),
			disable: () => ipc.invoke(WEB_ACCESS_CHANNELS.DISABLE),
			pair: () => ipc.invoke(WEB_ACCESS_CHANNELS.PAIR),
			revoke: (grantId) => ipc.invoke(WEB_ACCESS_CHANNELS.REVOKE, grantId),
		},
	};
}
