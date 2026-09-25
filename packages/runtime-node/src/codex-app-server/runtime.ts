import { codexGatewayThreadConfig } from "./provider-bridge.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { object, readThread, text } from "./protocol.js";
import { CodexRpcConnection } from "./rpc.js";
import { CodexAppServerSession } from "./session.js";
import { CodexStdioTransport } from "./stdio.js";
import { CodexRuntimeError, type OpenCodexSessionOptions } from "./types.js";
/** Explicit opt-in entrypoint. Does not mutate the user's login/config or select a model on their behalf. */
export async function openCodexAppServerSession(options: OpenCodexSessionOptions): Promise<CodexAppServerSession> {
	if (!isAbsolute(options.cwd))
		throw new CodexRuntimeError("CONFIGURATION", "Codex cwd must be an absolute path");
	if (options.threadId !== undefined && !options.threadId.trim()) {
		throw new CodexRuntimeError("CONFIGURATION", "A non-empty thread ID is required for resume");
	}
	const sandbox = options.sandbox ?? "read-only";
	if (sandbox !== "read-only" && sandbox !== "workspace-write")
		throw new CodexRuntimeError("CONFIGURATION", "Unsupported sandbox mode");
	if (sandbox === "workspace-write" && !options.onApproval) {
		throw new CodexRuntimeError("CONFIGURATION", "Workspace-write requires an explicit host approval handler");
	}
	const gateway = options.gateway ? codexGatewayThreadConfig(options.gateway) : undefined;
	const cwd = await realpath(options.cwd);
	const transport = await CodexStdioTransport.launch({ ...options, cwd }, { localGateway: Boolean(options.gateway) });
	let rpc: CodexRpcConnection | undefined;
	let session: CodexAppServerSession | undefined;
	try {
		rpc = new CodexRpcConnection(transport, {
			requestTimeoutMs: options.requestTimeoutMs, serverRequestTimeoutMs: options.serverRequestTimeoutMs,
			maxPendingRequests: options.maxPendingRequests,
			onRequest: (request) => session ? session.handleServerRequest(request) : Promise.reject(new CodexRuntimeError("UNSUPPORTED", "Session is not attached", request.method, -32601)),
		});
		await rpc.initialize();
		const response = object(await rpc.request(options.threadId ? "thread/resume" : "thread/start", {
			...(options.threadId ? { threadId: options.threadId } : {}), cwd,
			...(options.model ? { model: options.model } : {}),
			...(gateway ?? {}), sandbox, approvalPolicy: "on-request", approvalsReviewer: "user",
		}));
		if (gateway && (response.modelProvider !== gateway.modelProvider || response.model !== gateway.model)) {
			throw new CodexRuntimeError("PROVIDER_MISMATCH", "Codex did not bind the selected gateway/model");
		}
		const thread = readThread(response.thread);
		if (options.threadId && thread.id !== options.threadId)
			throw new CodexRuntimeError("PROTOCOL", "Resumed thread identity mismatch");
		const effectiveSandbox = object(response.sandbox);
		const expectedType = sandbox === "read-only" ? "readOnly" : "workspaceWrite";
		if (effectiveSandbox.type !== expectedType || effectiveSandbox.networkAccess !== false ||
			response.approvalPolicy !== "on-request" || response.approvalsReviewer !== "user" || await realpath(text(response.cwd, "cwd")) !== cwd) {
			throw new CodexRuntimeError("POLICY_MISMATCH", "Codex effective cwd/permissions differ from the requested profile");
		}
		if (sandbox === "workspace-write") {
			if (!Array.isArray(effectiveSandbox.writableRoots)) {
				throw new CodexRuntimeError("PROTOCOL", "Missing effective sandbox writable roots");
			}
			for (const root of effectiveSandbox.writableRoots) {
				const difference = relative(cwd, await realpath(text(root, "writableRoot")));
				if (isAbsolute(difference) || difference === ".." || difference.startsWith(`..${sep}`)) {
					throw new CodexRuntimeError("POLICY_MISMATCH", "Codex configuration grants writes outside the workspace");
				}
			}
		}
		session = new CodexAppServerSession(rpc, thread, options);
		return session;
	}
	catch (error) {
		try {
			await (rpc ? rpc.close() : transport.close());
		}
		catch { /* Preserve the original initialization failure. */ }
		throw error;
	}
}
