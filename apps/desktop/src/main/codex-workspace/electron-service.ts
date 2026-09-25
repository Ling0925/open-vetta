import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getVettaHomePath } from "@vetta/action-rpc";
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from "electron";
import { CODEX_WORKSPACE_CHANNELS } from "../../shared/codex-workspace.js";
import { mainT } from "../i18n/index.js";
import { registerQuitCleanupParticipant } from "../quit-cleanup.js";
import { createWorkspaceBackend } from "./backend.js";
import { prepareManagedCodexHome, readBundledCodexDefaults } from "./bundled-runtime.js";
import { CodexWorkspaceController } from "./controller.js";
import { listDesktopCodexModels } from "./model-source-host.js";
import { createCodexWorkspaceProfileStore } from "./profile-store.js";
import { isCodexWorkspaceSender, replacesMainDocument } from "./sender-policy.js";
import { CodexWorkspaceError } from "./validation.js";

/** Local UI owner and process lifetime. IPC registration delegates here without owning business state. */
export function createDesktopCodexWorkspace(owner: WebContents) {
	const root = join(getVettaHomePath(), "desktop-app", "codex-runtime");
	const store = createCodexWorkspaceProfileStore(join(root, "profile.json"));
	const rendererRoot = app.isPackaged ? app.getAppPath() : join(process.cwd(), "dist");
	const rendererUrl =
		process.env.VETTA_DESKTOP_DEV_URL ?? pathToFileURL(join(rendererRoot, "renderer/index.html")).href;
	let current: CodexWorkspaceController | undefined;
	let unsubscribe: (() => void) | undefined;
	let stopped = false;
	let retired: Promise<void> = Promise.resolve();
	const ensureSender = (event: IpcMainInvokeEvent) => {
		if (
			stopped ||
			owner.isDestroyed() ||
			!isCodexWorkspaceSender(
				{
					owner: event.sender === owner,
					mainFrame: event.senderFrame === owner.mainFrame,
					url: event.senderFrame?.url ?? "",
				},
				rendererUrl,
			)
		) {
			throw new CodexWorkspaceError("ACCESS_DENIED");
		}
	};
	const getWindow = () => {
		const window = BrowserWindow.fromWebContents(owner);
		if (!window || window.isDestroyed()) throw new CodexWorkspaceError("CLOSED");
		return window;
	};
	const create = () =>
		new CodexWorkspaceController({
			readProfile: store.read,
			readRuntimeDefaults: () =>
				app.isPackaged ? readBundledCodexDefaults(process.resourcesPath, root) : Promise.resolve(undefined),
			writeProfile: async (profile) => {
				await prepareManagedCodexHome(profile.codexHome, root);
				await store.write(profile);
			},
			listModels: listDesktopCodexModels,
			createBackend: (profile, approval) => createWorkspaceBackend(join(root, "sessions"), profile, approval),
			choosePath: async (field) => {
				const result = await dialog.showOpenDialog(getWindow(), {
					title: mainT(`codex:fields.${field}`),
					properties: field === "executable" ? ["openFile"] : ["openDirectory"],
				});
				return result.canceled ? undefined : result.filePaths[0];
			},
			confirmProfile: async (profile) => {
				const selectedModel = profile.vettaModelKey
					? (await listDesktopCodexModels()).find((item) => item.modelKey === profile.vettaModelKey)
					: undefined;
				if (profile.vettaModelKey && (!selectedModel || selectedModel.unavailable))
					throw new CodexWorkspaceError("MODEL_REFERENCE_MISSING");
				const detail = [
					...(selectedModel
						? [mainT("codex:existingModel"), selectedModel.label, selectedModel.baseUrl ?? ""]
						: []),
					`${mainT("codex:fields.executable")}: ${profile.executable}`,
					`${mainT("codex:fields.expectedVersion")}: ${profile.expectedVersion}`,
					`${mainT("codex:fields.model")}: ${profile.model ?? "—"}`,
					`${mainT("codex:fields.codexHome")}: ${profile.codexHome}`,
					`${mainT("codex:fields.cwd")}: ${profile.cwd}`,
					`${mainT("codex:fields.sandbox")}: ${mainT(`codex:permissions.${profile.sandbox}`)}`,
					mainT("codex:profileWarning"),
				].join("\n\n");
				const result = await dialog.showMessageBox(getWindow(), {
					type: "warning",
					title: mainT("codex:confirmTitle"),
					message: mainT("codex:confirmMessage"),
					detail,
					buttons: [mainT("codex:cancel"), mainT("codex:save")],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				return result.response === 1;
			},
		});
	const reset = () => {
		const previous = current;
		current = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		if (previous) {
			// Preserve failed cleanup as a barrier: never launch another owner if shutdown was not confirmed.
			const closing = previous.dispose();
			retired = Promise.all([retired, closing]).then(() => undefined);
			void retired.catch(() => undefined);
		}
	};
	const get = async () => {
		await retired;
		if (stopped || owner.isDestroyed()) throw new CodexWorkspaceError("CLOSED");
		if (!current) {
			current = create();
			unsubscribe = current.subscribe((notice) => {
				if (!owner.isDestroyed()) {
					try {
						owner.send(CODEX_WORKSPACE_CHANNELS.CHANGED, notice);
					} catch {
						/* View is gone. */
					}
				}
			});
		}
		return current;
	};
	const navigation = (details: unknown, _url?: string, inPlace?: boolean, mainFrame?: boolean) => {
		if (replacesMainDocument(details, inPlace, mainFrame)) reset();
	};
	owner.on("render-process-gone", reset);
	owner.on("did-start-navigation", navigation);
	owner.once("destroyed", reset);
	const dispose = () => {
		stopped = true;
		reset();
		return retired;
	};
	const unregisterQuit = registerQuitCleanupParticipant(dispose);
	return {
		attach: async (event: IpcMainInvokeEvent) => {
			ensureSender(event);
			const service = await get();
			ensureSender(event);
			return service.attach();
		},
		command: async (event: IpcMainInvokeEvent, token: unknown, command: unknown) => {
			ensureSender(event);
			if (!current) return { ok: false as const, code: "VIEW_EXPIRED" };
			return current.execute(token, command);
		},
		teardown: () => {
			owner.removeListener("render-process-gone", reset);
			owner.removeListener("did-start-navigation", navigation);
			owner.removeListener("destroyed", reset);
			void dispose().then(unregisterQuit, () => {
				/* Keep the quit participant when cleanup failed. */
			});
		},
	};
}
