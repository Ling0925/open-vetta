import { createSharedModelWorkspaceBackend } from "./shared-model-backend.js";
import { CodexRuntimeHostBackend } from "@vetta/runtime-node/codex-app-server";
import { FileConversationOwnershipManager } from "@vetta/runtime-node/conversation";
import type { CodexWorkspaceProfile } from "../../shared/codex-workspace.js";
import type { WorkspaceApprovalRequest } from "./approvals.js";
import type { WorkspaceBackend, WorkspaceSession } from "./controller.js";
import { codexHistoryRows } from "./history-rows.js";
import { WorkspaceTurnAdmission } from "./turn-admission.js";

export function createWorkspaceBackend(catalogRoot: string, profile: CodexWorkspaceProfile,
	approval: (request: WorkspaceApprovalRequest) => Promise<"accept" | "decline" | "cancel">): WorkspaceBackend {
	if (profile.vettaModelKey) return createSharedModelWorkspaceBackend(catalogRoot, profile, approval);
	const backend = new CodexRuntimeHostBackend({
		catalogRoot,
		profile: {
			id: "desktop-preview", executable: profile.executable, expectedVersion: profile.expectedVersion,
			codexHome: profile.codexHome, sandbox: profile.sandbox, model: profile.model, onApproval: approval
		},
		ownership: new FileConversationOwnershipManager(),
	});
	return {
		list: async () => (await backend.catalog.listSessions(profile.cwd)).slice(0, 200).map(session => ({
			id: session.id, name: session.name || session.firstMessage || session.id, modifiedAt: session.modifiedAt,
		})),
		open: async (sessionId): Promise<WorkspaceSession> => {
			const assembly = await backend.createAssembly({
				cwd: profile.cwd, executionMode: "sandbox",
				...(sessionId ? { sessionPath: await backend.catalog.pathFor(sessionId), sessionId } : {}),
				getSessionId: () => undefined,
			});
			const turns = new WorkspaceTurnAdmission(assembly.corePorts.turnControl);
			return {
				id: assembly.lifecycle.sessionId,
				snapshot: () => ({
					...codexHistoryRows(assembly.historyReader.readHistory()),
					recovery: turns.requiresRecovery() || backend.readSnapshot(assembly.lifecycle.sessionId).state === "recovery-required"
				}),
				subscribe: listener => assembly.corePorts.eventStream.subscribe(() => listener()),
				prompt: text => turns.prompt(text),
				stop: () => turns.stop(), close: () => turns.close(() => assembly.lifecycle.dispose()),
			};
		},
		close: () => backend.dispose(),
	};
}
