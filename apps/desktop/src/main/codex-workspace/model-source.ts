import { createHash } from "node:crypto";
import type { CodexModelChoice } from "../../shared/codex-workspace.js";

/** Narrow read view of ModelSettingsService. No new model or credential store. */
export interface ExistingModelConfig {
	defaultModel?: string;
	providers: Record<string, {
		baseUrl?: string; apiKey?: string; credentialRef?: string; api?: string;
		headers?: Record<string, string>; authHeader?: boolean; displayName?: string; useProxy?: boolean;
		models?: readonly { id: string; modelId?: string; name?: string; api?: string; reasoning?: boolean;
			defaultReasoningLevel?: string }[];
		modelOverrides?: Record<string, unknown>;
	}>;
}
export interface ResolvedCodexModel {
	/** Safe to persist: identifies settings, not a bearer credential or a transient listening port. */
	identity: string;
	/** Main-process-only comparison, including credentials. Never send it to IPC or persist it. */
	revision: string;
	providerId: string;
	model: string;
	baseUrl: string;
	headers: Record<string, string>;
	useProxy?: boolean;
	reasoning?: string;
}
export class CodexModelSourceError extends Error {
	constructor(readonly code: string) { super(code); this.name = "CodexModelSourceError"; }
}
const reject = (code: string): never => { throw new CodexModelSourceError(code); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const forbiddenHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade",
	"proxy-authorization", "proxy-connection", "te", "trailer", "cookie", "origin", "referer"]);

export function modelKeyParts(key: string): [string, string] {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1 || key.length > 512 || /[\x00-\x1f\x7f]/.test(key)) reject("MODEL_REFERENCE_INVALID");
	return [key.slice(0, slash), key.slice(slash + 1)];
}
function endpoint(raw: string | undefined): string {
	if (!raw || /[\x00-\x20\x7f]/.test(raw)) reject("GATEWAY_URL_INVALID");
	let url: URL;
	try { url = new URL(raw!); } catch { return reject("GATEWAY_URL_INVALID"); }
	if (url.username || url.password || url.search || url.hash || /\/(responses|chat\/completions)\/?$/.test(url.pathname)) reject("GATEWAY_URL_INVALID");
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) reject("GATEWAY_TLS_REQUIRED");
	return url.toString().replace(/\/+$/, "");
}
function selected(config: ExistingModelConfig, key: string) {
	const [providerId, modelId] = modelKeyParts(key);
	const provider = Object.hasOwn(config.providers, providerId) ? config.providers[providerId] : undefined;
	if (!provider) return reject("MODEL_REFERENCE_MISSING");
	const model = provider.models?.find(value => value.id === modelId);
	if (!model) return reject("MODEL_REFERENCE_MISSING");
	// Do not silently drop provider-specific request overrides or pretend Chat Completions is Responses.
	const overrides = provider.modelOverrides?.[modelId];
	if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Object.keys(overrides).length > 0)) reject("MODEL_OVERRIDES_UNSUPPORTED");
	if ((model.api ?? provider.api) !== "openai-responses") reject("RESPONSES_REQUIRED");
	const wireModel = model.modelId ?? model.id;
	if (!wireModel.trim() || wireModel.length > 512 || /[\x00-\x1f\x7f]/.test(wireModel)) reject("MODEL_REFERENCE_INVALID");
	const baseUrl = endpoint(provider.baseUrl);
	const reasoning = model.defaultReasoningLevel;
	if (reasoning && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(reasoning)) reject("REASONING_UNSUPPORTED");
	return { providerId, provider, model, wireModel, baseUrl, reasoning };
}

/** No credential resolution or gateway requests while rendering the choices. */
export function listCodexModelChoices(config: ExistingModelConfig): CodexModelChoice[] {
	return Object.entries(config.providers).flatMap(([providerId, provider]) => (provider.models ?? []).map(model => {
		const modelKey = `${providerId}/${model.id}`;
		let unavailable: string | undefined;
		let baseUrl: string | undefined;
		try { baseUrl = selected(config, modelKey).baseUrl; }
		catch (error) { unavailable = error instanceof CodexModelSourceError ? error.code : "MODEL_CONFIG_INVALID"; }
		return { modelKey, label: `${provider.displayName ?? providerId} / ${model.name ?? model.id}`,
			isDefault: config.defaultModel === modelKey, ...(baseUrl ? { baseUrl } : {}), ...(unavailable ? { unavailable } : {}) };
	}));
}

export function resolveCodexModel(config: ExistingModelConfig, key: string,
	resolveValue: (value: string) => string | undefined): ResolvedCodexModel {
	const { providerId, provider, wireModel, baseUrl, reasoning } = selected(config, key);
	const headers: Record<string, string> = Object.create(null) as Record<string, string>;
	const value = (raw: string): string => {
		// Existing command-backed credentials can run arbitrary processes. This preview does not add a new execution route.
		if (/^\s*(?:!|cmd:)/i.test(raw)) return reject("COMMAND_CREDENTIAL_UNSUPPORTED");
		let resolved: string | undefined;
		try { resolved = resolveValue(raw); } catch { return reject("CREDENTIAL_UNAVAILABLE"); }
		if (!resolved || resolved === "***" || /[\x00-\x1f\x7f]/.test(resolved) || resolved.length > 16384) return reject("CREDENTIAL_UNAVAILABLE");
		return resolved;
	};
	for (const [name, raw] of Object.entries(provider.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		const lower = name.toLowerCase();
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || forbiddenHeaders.has(lower) || lower.startsWith("sec-") ||
			lower.startsWith("x-forwarded-") || lower in headers) reject("GATEWAY_HEADER_UNSUPPORTED");
		headers[lower] = value(raw);
	}
	if (provider.authHeader !== false) {
		if (provider.apiKey) {
			if (headers.authorization) reject("GATEWAY_AUTH_CONFLICT");
			headers.authorization = `Bearer ${value(provider.apiKey)}`;
		} else if (!headers.authorization && !headers["api-key"] && !headers["x-api-key"]) reject("CREDENTIAL_UNAVAILABLE");
	}
	const publicIdentity = { modelKey: key, model: wireModel, baseUrl, api: "openai-responses",
		authHeader: provider.authHeader ?? true, credentialRef: provider.credentialRef ?? null,
		useProxy: provider.useProxy ?? null, reasoning: reasoning ?? null, headerNames: Object.keys(headers).sort() };
	return { identity: hash(publicIdentity), revision: hash({ ...publicIdentity, headers }), providerId,
		model: wireModel, baseUrl, headers, useProxy: provider.useProxy, ...(reasoning ? { reasoning } : {}) };
}
