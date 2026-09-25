import type { HostTransport } from "../../shared/host-transport.js";
import { CODEX_WORKSPACE_CHANNELS, type DesktopCodexWorkspaceApi } from "../../shared/codex-workspace.js";
import { onIpcEvent } from "./helper.js";

export function createCodexWorkspaceApi(ipc: HostTransport): { codexWorkspace: DesktopCodexWorkspaceApi } {
	return {
		codexWorkspace: {
			attach: () => ipc.invoke(CODEX_WORKSPACE_CHANNELS.ATTACH),
			command: (token, command) => ipc.invoke(CODEX_WORKSPACE_CHANNELS.COMMAND, token, command),
			onChanged: listener => onIpcEvent(ipc, CODEX_WORKSPACE_CHANNELS.CHANGED, listener),
		}
	};
}
