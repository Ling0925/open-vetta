import type { WebAccessProjectSnapshot, WebAccessWatchResponse } from "../shared/web-access.js";

export class WebAccessClientError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "WebAccessClientError";
	}
}

export interface WebBootstrapResult {
	readonly csrf: string;
	readonly expiresAt: number;
	readonly webOrigin: string;
}

export interface WebPairResult extends WebBootstrapResult {}

export async function pair(code: string, signal?: AbortSignal): Promise<WebPairResult> {
	return await request<WebPairResult>("/api/pair", undefined, { code }, signal);
}

export async function bootstrap(signal?: AbortSignal): Promise<WebBootstrapResult> {
	return await request<WebBootstrapResult>("/api/session/bootstrap", undefined, undefined, signal, "GET");
}

export async function logout(csrf: string, signal?: AbortSignal): Promise<void> {
	await request<{ loggedOut: true }>("/api/session/logout", csrf, {}, signal);
}

export async function snapshot(csrf: string, signal?: AbortSignal): Promise<WebAccessProjectSnapshot> {
	return await request<WebAccessProjectSnapshot>("/api/projects/snapshot", csrf, {}, signal);
}

export async function watch(
	csrf: string,
	input: { readonly generation: string; readonly cursor: number },
	signal?: AbortSignal,
): Promise<WebAccessWatchResponse> {
	return await request<WebAccessWatchResponse>("/api/projects/watch", csrf, { ...input, waitMs: 25_000 }, signal);
}

async function request<T>(
	path: string,
	csrf: string | undefined,
	body: unknown,
	signal?: AbortSignal,
	method: "GET" | "POST" = "POST",
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			credentials: "include",
			headers: {
				Accept: "application/json",
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				...(csrf ? { "X-Vetta-CSRF": csrf } : {}),
			},
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new WebAccessClientError("NETWORK_ERROR", "Network request failed", 0);
	}
	const payload = (await response.json().catch(() => undefined)) as
		| { readonly error?: { readonly code?: unknown; readonly message?: unknown } }
		| T
		| undefined;
	if (!response.ok) {
		const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
		const code = error && typeof error.code === "string" ? error.code : "WEB_ACCESS_REQUEST_FAILED";
		const message = error && typeof error.message === "string" ? error.message : "Web access request failed";
		throw new WebAccessClientError(code, message, response.status);
	}
	return payload as T;
}
