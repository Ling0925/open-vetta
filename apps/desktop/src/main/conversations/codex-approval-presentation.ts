import { createHash } from "node:crypto";
import type { ServerRequest } from "@vetta/runtime-node/codex-app-server";

export interface CodexApprovalPresentation {
	readonly kind: "command" | "file-change" | "other";
	readonly toolName: string;
	readonly command?: string;
	readonly cwd?: string;
	readonly paths: readonly string[];
}

function readString(params: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function readPath(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return readString(value as Readonly<Record<string, unknown>>, ["path", "file_path", "filePath"]);
}

function readPaths(params: Readonly<Record<string, unknown>>): string[] {
	const direct = readString(params, ["path", "file_path", "filePath"]);
	if (direct) return [direct];
	for (const key of ["changes", "files", "edits"] as const) {
		const value = params[key];
		if (!Array.isArray(value)) continue;
		const paths = value.map(readPath).filter((path): path is string => path !== undefined);
		if (paths.length > 0) return [...new Set(paths)];
	}
	return [];
}

export function codexApprovalRequestId(sessionId: string, request: Pick<ServerRequest, "id" | "method" | "params">): string {
	const identity = {
		sessionId,
		rpcId: String(request.id),
		method: request.method,
		threadId: readString(request.params, ["threadId"]) ?? "",
		turnId: readString(request.params, ["turnId"]) ?? "",
		itemId: readString(request.params, ["itemId"]) ?? "",
	};
	return `codex:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

/** Display-only projection for the existing permission drawer. The exact request
 * remains available separately; this helper never changes approval semantics. */
export function codexApprovalPresentation(
	request: Pick<ServerRequest, "method" | "params">,
	fallbackCwd: string,
): CodexApprovalPresentation {
	if (request.method === "item/commandExecution/requestApproval") {
		return {
			kind: "command",
			toolName: "codex.commandExecution",
			...(readString(request.params, ["command"]) ? { command: readString(request.params, ["command"]) } : {}),
			cwd: readString(request.params, ["cwd"]) ?? fallbackCwd,
			paths: [],
		};
	}
	if (request.method === "item/fileChange/requestApproval") {
		return {
			kind: "file-change",
			toolName: "codex.fileChange",
			cwd: readString(request.params, ["cwd"]) ?? fallbackCwd,
			paths: readPaths(request.params),
		};
	}
	return {
		kind: "other",
		toolName: `codex.${request.method}`,
		cwd: fallbackCwd,
		paths: [],
	};
}
