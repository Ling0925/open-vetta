import { isAbsolute } from "node:path";
import type { CodexWorkspaceCommand, CodexWorkspaceProfile } from "../../shared/codex-workspace.js";

export class CodexWorkspaceError extends Error {
	constructor(readonly code: string) { super(code); this.name = "CodexWorkspaceError"; }
}
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexWorkspaceError("INPUT");
	return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new CodexWorkspaceError("INPUT");
}
export function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new CodexWorkspaceError("INPUT");
	return value;
}
function path(value: unknown): string {
	if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value)) throw new CodexWorkspaceError("INPUT");
	return value;
}
export function profile(value: unknown): CodexWorkspaceProfile {
	const v = record(value);
	keys(v, ["executable", "expectedVersion", "codexHome", "cwd", "sandbox", "model"]);
	if (typeof v.expectedVersion !== "string" || !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(v.expectedVersion)) throw new CodexWorkspaceError("INPUT");
	if (v.sandbox !== "read-only" && v.sandbox !== "workspace-write") throw new CodexWorkspaceError("INPUT");
	if (v.model !== undefined && (typeof v.model !== "string" || v.model.length > 200 || /[\r\n\0]/.test(v.model))) throw new CodexWorkspaceError("INPUT");
	return {
		executable: path(v.executable), expectedVersion: v.expectedVersion, codexHome: path(v.codexHome),
		cwd: path(v.cwd), sandbox: v.sandbox, ...(v.model ? { model: String(v.model) } : {})
	};
}
export function command(value: unknown): CodexWorkspaceCommand {
	const v = record(value);
	switch (v.type) {
		case "snapshot": case "detach": case "close": keys(v, ["type"]); return { type: v.type };
		case "choose":
			keys(v, ["type", "field"]);
			if (v.field !== "executable" && v.field !== "codexHome" && v.field !== "cwd") throw new CodexWorkspaceError("INPUT");
			return { type: v.type, field: v.field };
		case "configure": keys(v, ["type", "profile"]); return { type: v.type, profile: profile(v.profile) };
		case "open": keys(v, ["type", "sessionId"]); return { type: v.type, ...(v.sessionId === undefined ? {} : { sessionId: identifier(v.sessionId) }) };
		case "send":
			keys(v, ["type", "sessionId", "inputId", "text"]);
			if (typeof v.text !== "string" || !v.text.trim() || v.text.length > 100000) throw new CodexWorkspaceError("INPUT");
			return { type: v.type, sessionId: identifier(v.sessionId), inputId: identifier(v.inputId), text: v.text };
		case "stop": keys(v, ["type", "sessionId", "inputId"]); return { type: v.type, sessionId: identifier(v.sessionId), inputId: identifier(v.inputId) };
		case "approval":
			keys(v, ["type", "approvalId", "decision"]);
			if (v.decision !== "accept" && v.decision !== "decline") throw new CodexWorkspaceError("INPUT");
			return { type: v.type, approvalId: identifier(v.approvalId), decision: v.decision };
		default: throw new CodexWorkspaceError("UNSUPPORTED");
	}
}
export function errorCode(value: unknown): string {
	const code = value && typeof value === "object" && "code" in value ? value.code : undefined;
	return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "CODEX_UNAVAILABLE";
}
