import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, type IpcMainInvokeEvent, ipcMain, type WebContents } from "electron";
import { SANDBOX_GRANT_RESOLVED_CHANNEL } from "../../shared/sandbox-grant-events.js";
import {
	SESSION_RUNTIME_BACKEND_CHANNELS as channels,
	type SessionRuntimeBackendReply,
} from "../../shared/session-runtime-backend.js";
import { isCodexWorkspaceSender } from "../codex-workspace/sender-policy.js";
import { getConversationRuntimeBackendSelection } from "../conversations/chat-runtime-host.js";
import {
	RuntimeBackendError,
	runtimeBackend,
	runtimeBackendErrorCode,
} from "../conversations/runtime-backend-choice.js";
import { getDesktopSandboxAuthorizationBroker } from "../conversations/sandbox-authorization-broker.js";
import { getSharedRuntime } from "../runtime.js";

/** Original-session operations only; the renderer cannot provide paths, credentials or RPC methods. */
export function registerSessionRuntimeBackendIpc(owner: WebContents): () => void {
	const root = app.isPackaged ? app.getAppPath() : join(process.cwd(), "dist");
	const renderer = process.env.VETTA_DESKTOP_DEV_URL ?? pathToFileURL(join(root, "renderer/index.html")).href;
	let disposed = false;
	function check(event: IpcMainInvokeEvent, id: unknown): asserts id is string {
		if (
			disposed ||
			owner.isDestroyed() ||
			!isCodexWorkspaceSender(
				{
					owner: event.sender === owner,
					mainFrame: event.senderFrame === owner.mainFrame,
					url: event.senderFrame?.url ?? "",
				},
				renderer,
			)
		) {
			throw new RuntimeBackendError("ACCESS_DENIED");
		}
		if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new RuntimeBackendError("INPUT");
	}
	ipcMain.handle(channels.READ, async (event, id: unknown): Promise<SessionRuntimeBackendReply> => {
		try {
			check(event, id);
			await getSharedRuntime();
			check(event, id);
			return { ok: true, state: getConversationRuntimeBackendSelection().read(id) };
		} catch (error) {
			return { ok: false, code: runtimeBackendErrorCode(error) };
		}
	});
	ipcMain.handle(
		channels.SELECT,
		async (event, id: unknown, value: unknown, expected: unknown): Promise<SessionRuntimeBackendReply> => {
			try {
				check(event, id);
				if (typeof expected !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(expected))
					throw new RuntimeBackendError("INPUT");
				const backend = runtimeBackend(value);
				await getSharedRuntime();
				check(event, id);
				return { ok: true, state: await getConversationRuntimeBackendSelection().select(id, backend, expected) };
			} catch (error) {
				return { ok: false, code: runtimeBackendErrorCode(error) };
			}
		},
	);
	const unsubscribe = getConversationRuntimeBackendSelection().subscribe((state) => {
		if (!disposed && !owner.isDestroyed()) {
			try {
				owner.send(channels.CHANGED, state);
			} catch {
				/* Window may close between checks. */
			}
		}
	});
	const removeResolved = getDesktopSandboxAuthorizationBroker().onResolved((event) => {
		if (!disposed && !owner.isDestroyed()) {
			try {
				owner.send(SANDBOX_GRANT_RESOLVED_CHANNEL, event);
			} catch {
				/* A closing window cannot process approvals. */
			}
		}
	});
	return () => {
		disposed = true;
		unsubscribe();
		removeResolved();
		ipcMain.removeHandler(channels.READ);
		ipcMain.removeHandler(channels.SELECT);
	};
}
