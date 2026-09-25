import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { getVettaHomePath } from "@vetta/action-rpc";
import type { Api, Model } from "@vetta/ai";
import {
	CODING_AGENT_BACKGROUND_TASKS_READ,
	CODING_AGENT_PLAN_MODE_STATE_READ,
	CODING_AGENT_SUBAGENTS_READ,
} from "@vetta/coding-agent/session-extensions";
import type { RuntimeHostSessionAssembly } from "@vetta/runtime-core";
import type { TurnEngineRequest } from "@vetta/runtime-core/kernel";
import {
	type CodexAppServerSession,
	CodexConversationTurnEngine,
	CodexRuntimeError,
	openCodexAppServerSession,
	type ServerRequest,
	startCodexProviderBridge,
} from "@vetta/runtime-node/codex-app-server";
import { isSshProjectUri } from "@vetta/ssh-transport/project-uri";
import { prepareManagedCodexHome, readBundledCodexDefaults } from "../codex-workspace/bundled-runtime.js";
import { createDesktopCodexModelSource } from "../codex-workspace/model-source-host.js";
import { mainT } from "../i18n/index.js";
import { assertOrdinaryConversationPath } from "./conversation-ownership-guard.js";
import { RuntimeBackendError } from "./runtime-backend-choice.js";
import { ConversationRuntimeBackendSelection } from "./runtime-backend-selection.js";
import { getDesktopSandboxAuthorizationBroker } from "./sandbox-authorization-broker.js";
import { readSessionAgentBinding } from "./session-agent-binding-store.js";

function localWorkspace(assembly: RuntimeHostSessionAssembly): string {
	const cwd = assembly.workspaceView.readWorkingDirectory();
	if (!cwd || isSshProjectUri(cwd) || !isAbsolute(cwd)) throw new RuntimeBackendError("CODEX_LOCAL_PROJECT_REQUIRED");
	return cwd;
}
function assertNoNativeWork(assembly: RuntimeHostSessionAssembly): void {
	const extensions = assembly.extensionHost;
	if (!extensions) return;
	if (
		extensions.hasEndpoint(CODING_AGENT_PLAN_MODE_STATE_READ) &&
		extensions.invokeSync(CODING_AGENT_PLAN_MODE_STATE_READ, undefined).permissionMode === "plan"
	) {
		throw new RuntimeBackendError("CODEX_PLAN_MODE_UNSUPPORTED");
	}
	if (
		extensions.hasEndpoint(CODING_AGENT_BACKGROUND_TASKS_READ) &&
		extensions.invokeSync(CODING_AGENT_BACKGROUND_TASKS_READ, undefined).some((task) => task.status === "running")
	) {
		throw new RuntimeBackendError("RUNTIME_BACKGROUND_WORK_ACTIVE");
	}
	if (
		extensions.hasEndpoint(CODING_AGENT_SUBAGENTS_READ) &&
		extensions
			.invokeSync(CODING_AGENT_SUBAGENTS_READ, undefined)
			.some((task) => task.status === "running" || task.status === "pending")
	) {
		throw new RuntimeBackendError("RUNTIME_BACKGROUND_WORK_ACTIVE");
	}
}
function modelSource(model: Model<Api> | undefined) {
	if (!model) throw new RuntimeBackendError("MODEL_REFERENCE_MISSING");
	return createDesktopCodexModelSource(`${model.provider}/${model.id}`);
}
async function validateConversation(assembly: RuntimeHostSessionAssembly) {
	assertNoNativeWork(assembly);
	const cwd = localWorkspace(assembly);
	const path = assembly.lifecycle.sessionPath;
	if (!path) throw new RuntimeBackendError("SESSION_UNAVAILABLE");
	await assertOrdinaryConversationPath(path);
	// A restricted Agent's allow-list must not become the unrestricted Codex tool set.
	if (await readSessionAgentBinding(path)) throw new RuntimeBackendError("CODEX_AGENT_PROFILE_UNSUPPORTED");
	const root = join(getVettaHomePath(), "desktop-app", "codex-chat-runtime");
	const defaults = await readBundledCodexDefaults(process.resourcesPath, root);
	if (!defaults) throw new RuntimeBackendError("CODEX_NOT_INSTALLED");
	const canonical = await realpath(cwd);
	const difference = relative(canonical, root);
	if (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`)) {
		throw new RuntimeBackendError("CODEX_WORKSPACE_OVERLAP");
	}
	return { cwd: canonical, root, defaults };
}

async function approve(sessionId: string, cwd: string, request: ServerRequest) {
	const details = JSON.stringify(request.params, null, 2);
	if (request.signal.aborted || Buffer.byteLength(details) > 65536) return "decline" as const;
	const decision = await getDesktopSandboxAuthorizationBroker().handle(
		{
			requestId: randomUUID(),
			sessionId,
			title: mainT("codex:chatApprovalTitle"),
			message: `${mainT("codex:chatApprovalScope")}\n\n${details}`,
			toolName: `codex.${request.method}`,
			capability: "file.write",
			target: cwd,
			resolvedTarget: cwd,
			// The existing permission drawer intentionally omits a session-wide grant for sensitive requests.
			sensitive: true,
		},
		request.signal,
	);
	return !request.signal.aborted && decision === "allow_once" ? ("accept" as const) : ("decline" as const);
}

async function connect(request: TurnEngineRequest) {
	const assembly = selection.assemblyFor(request.sessionId);
	const { cwd, root, defaults } = await validateConversation(assembly);
	request.signal.throwIfAborted();
	await prepareManagedCodexHome(defaults.codexHome, root);
	request.signal.throwIfAborted();
	const source = modelSource(request.modelBinding?.model);
	const bridge = await startCodexProviderBridge(
		{
			...source,
			resolve: async () => ({ ...(await source.resolve()), reasoning: request.modelBinding?.reasoning ?? "none" }),
		},
		request.signal,
	);
	let session: CodexAppServerSession | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= Promise.resolve().then(async () => {
			const cleanup = await Promise.allSettled([bridge.close(), session?.close()]);
			if (cleanup.some((result) => result.status === "rejected")) {
				throw new CodexRuntimeError("CLEANUP_UNCONFIRMED", "The previous Codex runtime could not be closed");
			}
		});
		return closing;
	};
	try {
		request.signal.throwIfAborted();
		session = await openCodexAppServerSession({
			...defaults,
			cwd,
			gateway: bridge.provider,
			sandbox: "workspace-write",
			onApproval: (value) => approve(request.sessionId, cwd, value),
		});
		request.signal.throwIfAborted();
		return { session, close };
	} catch (error) {
		await close();
		throw error;
	}
}
const engine = new CodexConversationTurnEngine(connect);
const selection = new ConversationRuntimeBackendSelection({
	codex: engine,
	assertReusable: (id) => engine.assertReusable(id),
	validateCodex: async (assembly) => {
		await validateConversation(assembly);
		await modelSource(assembly.modelView.readCurrentModel()).resolve();
	},
});

/** Application composition and session IPC share this owner; no model work runs on import. */
export function getConversationRuntimeBackendSelection() {
	return selection;
}
