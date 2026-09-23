import type { HostTransport } from "../../shared/host-transport.js";
import { TELEMETRY_CONTEXT_CHANNEL } from "../../shared/telemetry.js";
import type { DesktopApi } from "../api.js";

export function createTelemetryApi(ipc: HostTransport): Pick<DesktopApi, "telemetry"> {
	return {
		telemetry: {
			setContext: (context) => ipc.send(TELEMETRY_CONTEXT_CHANNEL, context),
		},
	};
}
