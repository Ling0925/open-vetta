import {
	CodexHostSessionCatalog, CodexRuntimeHostBackend, openCodexAppServerSession, startCodexProviderBridge,
	type CodexProviderBridge,
} from "@vetta/runtime-node/codex-app-server";
import { FileConversationOwnershipManager } from "@vetta/runtime-node/conversation";
import type { CodexWorkspaceProfile } from "../../shared/codex-workspace.js";
import type { WorkspaceApprovalRequest } from "./approvals.js";
import type { WorkspaceBackend, WorkspaceSession } from "./controller.js";
import { codexHistoryRows } from "./history-rows.js";
import { createDesktopCodexModelSource } from "./model-source-host.js";
import { CodexWorkspaceError, errorCode } from "./validation.js";

/** Only model references persist. Each open owns a fresh local credential bridge and Codex backend. */
export function createSharedModelWorkspaceBackend(catalogRoot: string, profile: CodexWorkspaceProfile,
	approval: (request: WorkspaceApprovalRequest) => Promise<"accept" | "decline" | "cancel">): WorkspaceBackend {
	const modelKey = profile.vettaModelKey;
	if (!modelKey) throw new CodexWorkspaceError("MODEL_REFERENCE_INVALID");
	const ownership = new FileConversationOwnershipManager();
	const catalog = new CodexHostSessionCatalog(catalogRoot, ownership);
	let disposed = false;
	let opening: Promise<WorkspaceSession> | undefined;
	let active: { backend: CodexRuntimeHostBackend; bridge: CodexProviderBridge; release(): Promise<void> } | undefined;
	let disposing: Promise<void> | undefined;
	return {
		list: async () => (await catalog.listSessions(profile.cwd)).slice(0, 200).map(session => ({
			id: session.id, name: session.name || session.firstMessage || session.id, modifiedAt: session.modifiedAt,
		})),
		open: sessionId => {
			if (disposed) return Promise.reject(new CodexWorkspaceError("CLOSED"));
			if (opening || active) return Promise.reject(new CodexWorkspaceError("BUSY"));
			const work = Promise.resolve().then(async (): Promise<WorkspaceSession> => {
				const bridge = await startCodexProviderBridge(createDesktopCodexModelSource(modelKey));
				let backend: CodexRuntimeHostBackend | undefined;
				try {
					if (disposed) throw new CodexWorkspaceError("CLOSED");
					backend = new CodexRuntimeHostBackend({
						catalogRoot, ownership,
						profile: { id: "desktop-preview", executable: profile.executable, expectedVersion: profile.expectedVersion,
							codexHome: profile.codexHome, sandbox: profile.sandbox, model: bridge.provider.model,
							providerIdentity: bridge.identity, onApproval: approval },
						connect: async options => {
							await bridge.assertCurrent();
							return openCodexAppServerSession({ ...options, gateway: bridge.provider });
						},
					});
					const owner = backend;
					const assembly = await owner.createAssembly({ cwd: profile.cwd, executionMode: "sandbox",
						...(sessionId ? { sessionPath: await catalog.pathFor(sessionId), sessionId } : {}), getSessionId: () => undefined });
					if (disposed) throw new CodexWorkspaceError("CLOSED");
					let releasing: Promise<void> | undefined;
					const resource = { backend: owner, bridge, release: (): Promise<void> => {
						releasing ??= (async () => {
							// Revoke local network access first, even if the external process ignores cancellation.
							const cleanup = await Promise.allSettled([bridge.close(), owner.dispose()]);
							if (cleanup.some(result => result.status === "rejected")) throw new CodexWorkspaceError("CLEANUP_UNCONFIRMED");
							if (active === resource) active = undefined;
						})();
						return releasing;
					} };
					active = resource;
					return {
						id: assembly.lifecycle.sessionId,
						snapshot: () => ({ ...codexHistoryRows(assembly.historyReader.readHistory()),
							recovery: owner.readSnapshot(assembly.lifecycle.sessionId).state === "recovery-required" }),
						subscribe: listener => assembly.corePorts.eventStream.subscribe(() => listener()),
						prompt: async text => {
							await bridge.assertCurrent();
							const result = await assembly.corePorts.turnControl.prompt({ text });
							if (!result || !["completed", "cancelled", "failed"].includes(result.status)) throw new CodexWorkspaceError("OUTCOME_UNKNOWN");
							return { status: result.status as "completed" | "cancelled" | "failed",
								...(result.error ? { errorCode: errorCode(result.error) } : {}) };
						},
						stop: () => assembly.corePorts.turnControl.abort(), close: resource.release,
					};
				} catch (error) {
					const cleanup = await Promise.allSettled([bridge.close(), backend?.dispose()]);
					if (cleanup.some(result => result.status === "rejected")) {
						disposed = true; throw new CodexWorkspaceError("CLEANUP_UNCONFIRMED");
					}
					throw error;
				}
			});
			opening = work;
			void work.then(() => { if (opening === work) opening = undefined; }, () => { if (opening === work) opening = undefined; });
			return work;
		},
		close: () => {
			if (disposing) return disposing;
			disposed = true;
			disposing = (async () => {
				await opening?.catch(() => undefined);
				await active?.release();
			})();
			return disposing;
		},
	};
}
