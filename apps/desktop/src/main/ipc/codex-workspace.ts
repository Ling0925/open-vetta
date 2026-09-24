import { ipcMain, type WebContents } from "electron";
import { CODEX_WORKSPACE_CHANNELS } from "../../shared/codex-workspace.js";
import { createDesktopCodexWorkspace } from "../codex-workspace/electron-service.js";

export function registerCodexWorkspaceIpc(webContents: WebContents): () => void {
	const service = createDesktopCodexWorkspace(webContents);
	ipcMain.handle(CODEX_WORKSPACE_CHANNELS.ATTACH, event => service.attach(event));
	ipcMain.handle(CODEX_WORKSPACE_CHANNELS.COMMAND, (event, token: unknown, command: unknown) => service.command(event, token, command));
	return () => {
		ipcMain.removeHandler(CODEX_WORKSPACE_CHANNELS.ATTACH);
		ipcMain.removeHandler(CODEX_WORKSPACE_CHANNELS.COMMAND);
		service.teardown();
	};
}
