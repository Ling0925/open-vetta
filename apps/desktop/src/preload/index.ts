import { contextBridge, ipcRenderer, webUtils } from "electron";
import "./telemetry.js";
import type { DesktopApi } from "./api.js";
import { createElectronHostTransport } from "./electron-host-transport.js";
import { createHostAccessGate } from "./host-access.js";
import { createRawDesktopApi } from "./raw-api.js";
import { createUserActivityReporter, USER_ACTIVITY_CHANNEL } from "./user-activity.js";

const reportUserActivity = createUserActivityReporter(() => ipcRenderer.send(USER_ACTIVITY_CHANNEL)).report;

for (const eventName of ["keydown", "mousedown", "mousemove", "touchstart", "wheel"] as const) {
	window.addEventListener(eventName, reportUserActivity, { capture: true, passive: true });
}

const transport = createElectronHostTransport(ipcRenderer, webUtils);
const rawApi = createRawDesktopApi(transport);

const hostGate = createHostAccessGate(rawApi);
const api: DesktopApi = {
	hostAccess: hostGate.hostAccess,
	...hostGate.api,
};

contextBridge.exposeInMainWorld("vetta", api);
