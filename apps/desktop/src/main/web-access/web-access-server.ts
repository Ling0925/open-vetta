import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
	type AuthenticatedGrant,
	WEB_ACCESS_COOKIE_NAME,
	WEB_ACCESS_CSRF_HEADER,
	WEB_ACCESS_HTTP_COOKIE_NAME,
	type WebAccessAuthorization,
} from "./authorization.js";
import { isPrivateLanIPv4 } from "./lan-addresses.js";
import type { ProjectSnapshotSource } from "./project-snapshot.js";
import type { WebStaticAssets } from "./static-assets.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_WAIT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 64;
const MAX_ACTIVE_WATCHES_PER_GRANT = 2;
const MAX_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_ACTIVE_REQUESTS = 64;
const MAX_ACTIVE_REQUESTS_PER_GRANT = 8;
const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy":
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
} as const;

export interface WebAccessServerOptions {
	readonly origin: string;
	readonly port: number;
	readonly generation?: number;
	readonly assets: WebStaticAssets;
	readonly authorization: WebAccessAuthorization;
	readonly projects: ProjectSnapshotSource;
}

export interface WebAccessServerHandle {
	readonly address: string;
	readonly close: () => Promise<void>;
	readonly abortGrant: (grantId: string) => void;
}

export function getWebAccessBindHost(origin: string): string {
	const url = new URL(origin);
	if (url.protocol === "https:") return "127.0.0.1";
	if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || isPrivateLanIPv4(url.hostname)))
		return url.hostname;
	throw new Error("Web access can only bind a local private IPv4 address or a loopback HTTPS upstream");
}

export async function startWebAccessServer(options: WebAccessServerOptions): Promise<WebAccessServerHandle> {
	const host = getWebAccessBindHost(options.origin);
	const activeRequests = new Map<string, Set<AbortController>>();
	const activeWatches = new Map<string, Set<AbortController>>();
	const allRequests = new Set<AbortController>();
	const server = createServer((request, response) => {
		if (allRequests.size >= MAX_ACTIVE_REQUESTS) {
			sendError(response, 429, "WEB_ACCESS_REQUEST_LIMIT", "Too many active web access requests");
			return;
		}
		const controller = new AbortController();
		allRequests.add(controller);
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const onRequestAbort = (): void => controller.abort();
		const onResponseClose = (): void => {
			if (!response.writableEnded) controller.abort();
		};
		const onAbort = (): void => {
			if (!response.writableEnded) response.destroy();
		};
		request.once("aborted", onRequestAbort);
		response.once("close", onResponseClose);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		void handleRequest(request, response, options, activeRequests, activeWatches, controller)
			.catch((error: unknown) => {
				if (!response.headersSent) sendError(response, 500, "WEB_ACCESS_INTERNAL", "Web access request failed");
				else response.destroy(error instanceof Error ? error : undefined);
			})
			.finally(() => {
				clearTimeout(timeout);
				request.off("aborted", onRequestAbort);
				response.off("close", onResponseClose);
				controller.signal.removeEventListener("abort", onAbort);
				allRequests.delete(controller);
			});
	});
	server.maxConnections = MAX_CONNECTIONS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.headersTimeout = REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = 5_000;
	await listen(server, host, options.port);
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
	return {
		address: `http://${host}:${actualPort}`,
		close: async () => {
			// 先中止全部在途请求与观察，再等监听器关掉。观察集合单独遍历，不依赖
			// 「每个 watch 一定也在 allRequests 里」这个隐含前提。
			for (const controller of allRequests) controller.abort();
			for (const controllers of activeRequests.values()) {
				for (const controller of controllers) controller.abort();
			}
			for (const controllers of activeWatches.values()) {
				for (const controller of controllers) controller.abort();
			}
			await close(server);
		},
		abortGrant: (grantId) => {
			// 撤销必须同时结束该授权的长轮询等待：只取消普通请求的话，一个已被撤销的标签页
			// 会继续挂着观察连接，直到下一轮变化才失败。
			for (const controller of activeRequests.get(grantId) ?? []) controller.abort();
			for (const controller of activeWatches.get(grantId) ?? []) controller.abort();
		},
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	options: WebAccessServerOptions,
	activeRequests: Map<string, Set<AbortController>>,
	activeWatches: Map<string, Set<AbortController>>,
	controller: AbortController,
): Promise<void> {
	const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	const isBootstrap = pathname === "/api/session/bootstrap";
	if (!validateHeaders(request, options.origin, pathname.startsWith("/api/") && !isBootstrap, isBootstrap)) {
		sendError(response, 403, "WEB_ACCESS_ORIGIN_REJECTED", "This request is not from the configured web origin");
		return;
	}
	if (!validateCookieHeaders(request)) {
		sendError(response, 400, "WEB_ACCESS_INVALID_COOKIE", "Cookie header is ambiguous");
		return;
	}
	if (request.method === "GET" && !isBootstrap) {
		serveStatic(response, options.assets, pathname);
		return;
	}
	if (isBootstrap) {
		if (request.method !== "GET") {
			sendError(response, 405, "WEB_ACCESS_METHOD_NOT_ALLOWED", "Bootstrap uses GET");
			return;
		}
		handleBootstrap(request, response, options);
		return;
	}
	if (request.method !== "POST") {
		sendError(response, 405, "WEB_ACCESS_METHOD_NOT_ALLOWED", "Only POST is allowed for this endpoint");
		return;
	}
	const contentType = readHeader(request, "content-type");
	if (!contentType || !/^application\/json(?:\s*;\s*charset=[^;]+)?$/i.test(contentType.trim())) {
		sendError(response, 415, "WEB_ACCESS_JSON_REQUIRED", "This endpoint requires JSON");
		return;
	}
	const body = await readJson(request, controller.signal);
	if (!body.ok) {
		sendError(response, controller.signal.aborted ? 408 : 400, "WEB_ACCESS_INVALID_BODY", body.message);
		return;
	}
	if (pathname === "/api/pair") {
		const pairInput = readPairInput(body.value);
		if (!pairInput) {
			sendError(response, 400, "WEB_ACCESS_INVALID_BODY", "Pairing body contains unknown or invalid fields");
			return;
		}
		await handlePair(response, pairInput, options);
		return;
	}
	const grant = requireGrant(request, response, options);
	if (!grant) return;
	const grantExpiryTimer = setTimeout(() => controller.abort(), Math.max(0, grant.expiresAt - Date.now()));
	const requestControllers = activeRequests.get(grant.id) ?? new Set<AbortController>();
	// 单个授权不能靠流水线请求把宿主内存占满。
	if (requestControllers.size >= MAX_ACTIVE_REQUESTS_PER_GRANT) {
		sendError(response, 429, "WEB_ACCESS_REQUEST_LIMIT", "Too many active web access requests for this grant");
		return;
	}
	requestControllers.add(controller);
	activeRequests.set(grant.id, requestControllers);
	try {
		if (pathname === "/api/session/logout") {
			if (!isEmptyObject(body.value)) {
				sendError(response, 400, "WEB_ACCESS_INVALID_BODY", "Logout body must be empty");
				return;
			}
			handleLogout(response, options.authorization, grant, activeRequests, controller, options.origin);
			return;
		}
		if (pathname === "/api/projects/snapshot") {
			if (!isEmptyObject(body.value)) {
				sendError(response, 400, "WEB_ACCESS_INVALID_BODY", "Snapshot body must be empty");
				return;
			}
			await handleSnapshot(response, options.projects, grant, options.authorization, controller.signal);
			return;
		}
		if (pathname === "/api/projects/watch") {
			const input = readWatchInput(body.value);
			if (!input.ok) {
				sendError(response, 400, "WEB_ACCESS_INVALID_BODY", input.message);
				return;
			}
			await handleWatch(response, input.value, grant, options, activeWatches, controller);
			return;
		}
		sendError(response, 404, "WEB_ACCESS_NOT_FOUND", "Web access endpoint not found");
	} finally {
		clearTimeout(grantExpiryTimer);
		requestControllers.delete(controller);
		if (requestControllers.size === 0) activeRequests.delete(grant.id);
	}
}

async function handlePair(
	response: ServerResponse,
	input: { readonly code: string },
	options: WebAccessServerOptions,
): Promise<void> {
	const code = input.code;
	const result = options.authorization.consumePairing(code, {
		origin: options.origin,
		generation: options.generation ?? 0,
		scopes: ["projects.read"],
	});
	if (!result.ok) {
		sendError(
			response,
			result.reason === "limit" ? 429 : 401,
			result.reason === "limit" ? "WEB_ACCESS_PAIRING_LIMIT" : "WEB_ACCESS_PAIRING_INVALID",
			result.reason === "expired" ? "The pairing code has expired" : "The pairing code is invalid",
		);
		return;
	}
	setCookie(response, result.cookie, result.grant.expiresAt, options.origin);
	sendJson(response, 200, {
		csrf: result.csrf,
		expiresAt: result.grant.expiresAt,
		webOrigin: options.origin,
	});
}

function handleBootstrap(request: IncomingMessage, response: ServerResponse, options: WebAccessServerOptions): void {
	const cookie = readCookie(request.headers.cookie, options.origin);
	if (!cookie) {
		sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "Pair this browser from Desktop first");
		return;
	}
	const result = options.authorization.bootstrap(cookie, {
		origin: options.origin,
		generation: options.generation ?? 0,
	});
	if (!result) {
		clearCookie(response, options.origin);
		sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "This browser authorization is no longer valid");
		return;
	}
	setCookie(response, cookie, result.grant.expiresAt, options.origin);
	sendJson(response, 200, { csrf: result.csrf, expiresAt: result.grant.expiresAt, webOrigin: options.origin });
}

function handleLogout(
	response: ServerResponse,
	authorization: WebAccessAuthorization,
	grant: AuthenticatedGrant,
	activeRequests: Map<string, Set<AbortController>>,
	currentController: AbortController,
	origin: string,
): void {
	authorization.revoke(grant.id);
	for (const controller of activeRequests.get(grant.id) ?? []) {
		if (controller !== currentController) controller.abort();
	}
	clearCookie(response, origin);
	sendJson(response, 200, { loggedOut: true });
}

async function handleSnapshot(
	response: ServerResponse,
	projects: ProjectSnapshotSource,
	grant: AuthenticatedGrant,
	authorization: WebAccessAuthorization,
	signal: AbortSignal,
): Promise<void> {
	const snapshot = await projects.read();
	if (signal.aborted || !authorization.isActive(grant.id)) {
		sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "This browser authorization is no longer valid");
		return;
	}
	sendJson(response, 200, snapshot);
}

async function handleWatch(
	response: ServerResponse,
	value: { readonly generation?: string; readonly cursor?: number; readonly waitMs: number },
	grant: AuthenticatedGrant,
	options: WebAccessServerOptions,
	activeWatches: Map<string, Set<AbortController>>,
	controller: AbortController,
): Promise<void> {
	const requestControllers = activeWatches.get(grant.id) ?? new Set<AbortController>();
	if (requestControllers.size >= MAX_ACTIVE_WATCHES_PER_GRANT) {
		sendError(response, 429, "WEB_ACCESS_WATCH_LIMIT", "Too many project watch requests");
		return;
	}
	const position = options.projects.getPosition?.();
	if (
		position &&
		(value.generation !== position.generation || value.cursor === undefined || value.cursor !== position.cursor)
	) {
		const snapshot = await options.projects.read();
		if (controller.signal.aborted || !options.authorization.isActive(grant.id)) {
			sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "This browser authorization is no longer valid");
			return;
		}
		sendJson(response, 200, { changed: true, snapshot });
		return;
	}
	requestControllers.add(controller);
	activeWatches.set(grant.id, requestControllers);
	try {
		const result = await options.projects.waitForChange(
			value.generation,
			value.cursor,
			controller.signal,
			value.waitMs,
		);
		if (controller.signal.aborted || !options.authorization.isActive(grant.id)) {
			sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "This browser authorization is no longer valid");
			return;
		}
		sendJson(response, 200, result);
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			if (!response.headersSent)
				sendError(response, 401, "WEB_ACCESS_ABORTED", "The web access request was cancelled");
			return;
		}
		if (!response.headersSent) {
			sendError(response, 503, "WEB_ACCESS_PROJECTS_UNAVAILABLE", "Project data is temporarily unavailable");
		}
	} finally {
		requestControllers.delete(controller);
		if (requestControllers.size === 0) activeWatches.delete(grant.id);
	}
}

function requireGrant(
	request: IncomingMessage,
	response: ServerResponse,
	options: WebAccessServerOptions,
): AuthenticatedGrant | undefined {
	const cookie = readCookie(request.headers.cookie, options.origin);
	const csrf = readHeader(request, WEB_ACCESS_CSRF_HEADER);
	if (!cookie || !csrf) {
		sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "Pair this browser from Desktop first");
		return undefined;
	}
	const grant = options.authorization.authenticate(cookie, csrf, {
		origin: options.origin,
		generation: options.generation ?? 0,
	});
	if (!grant) {
		sendError(response, 401, "WEB_ACCESS_UNAUTHORIZED", "This browser authorization is no longer valid");
		return undefined;
	}
	return grant;
}

function validateHeaders(
	request: IncomingMessage,
	origin: string,
	requireOrigin: boolean,
	allowMissingOrigin = false,
): boolean {
	// Forwarded/X-Forwarded-* are deliberately ignored. Host and Origin below remain authoritative.
	const hostValues = readRawHeaders(request, "host");
	if (hostValues.length !== 1 || hostValues[0] !== new URL(origin).host) return false;
	const originValues = readRawHeaders(request, "origin");
	if (originValues.length > 1) return false;
	if (requireOrigin && (originValues.length !== 1 || originValues[0] !== origin)) return false;
	if (!requireOrigin && originValues.length === 1 && originValues[0] !== origin) return false;
	if (allowMissingOrigin && originValues.length === 0) return true;
	return true;
}

function readRawHeaders(request: IncomingMessage, name: string): string[] {
	const lower = name.toLowerCase();
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === lower) values.push(request.rawHeaders[index + 1] ?? "");
	}
	return values;
}

function readJson(
	request: IncomingMessage,
	signal: AbortSignal,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }> {
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let tooLarge = false;
		let settled = false;
		const cleanup = (): void => {
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		const finish = (
			result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string },
		): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const onData = (chunk: Buffer | string): void => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				tooLarge = true;
				return;
			}
			if (!tooLarge) chunks.push(buffer);
		};
		const onEnd = (): void => {
			if (tooLarge) {
				finish({ ok: false, message: "Request body is too large" });
				return;
			}
			try {
				finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
			} catch {
				finish({ ok: false, message: "Request body must be valid JSON" });
			}
		};
		const onError = (): void => finish({ ok: false, message: "Request body could not be read" });
		const onAbort = (): void => {
			request.destroy();
			finish({ ok: false, message: "Request body read was cancelled" });
		};
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

function readWatchInput(value: unknown):
	| {
			readonly ok: true;
			readonly value: { readonly generation?: string; readonly cursor?: number; readonly waitMs: number };
	  }
	| { readonly ok: false; readonly message: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, message: "Watch body must be an object" };
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if (keys.some((key) => !["generation", "cursor", "waitMs"].includes(key))) {
		return { ok: false, message: "Watch body contains unknown fields" };
	}
	if (
		input.generation !== undefined &&
		(typeof input.generation !== "string" || input.generation.length === 0 || input.generation.length > 128)
	) {
		return { ok: false, message: "Watch generation is invalid" };
	}
	if (
		input.cursor !== undefined &&
		(typeof input.cursor !== "number" || !Number.isSafeInteger(input.cursor) || input.cursor < 0)
	) {
		return { ok: false, message: "Watch cursor is invalid" };
	}
	if (
		input.waitMs !== undefined &&
		(typeof input.waitMs !== "number" ||
			!Number.isSafeInteger(input.waitMs) ||
			input.waitMs < 0 ||
			input.waitMs > MAX_WAIT_MS)
	) {
		return { ok: false, message: "Watch waitMs is invalid" };
	}
	return {
		ok: true,
		value: {
			...(input.generation !== undefined ? { generation: input.generation } : {}),
			...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
			waitMs: input.waitMs ?? MAX_WAIT_MS,
		},
	};
}

function readPairInput(value: unknown): { readonly code: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 1 ||
		typeof input.code !== "string" ||
		input.code.length === 0 ||
		input.code.length > 512
	)
		return undefined;
	return { code: input.code };
}

function isEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function validateCookieHeaders(request: IncomingMessage): boolean {
	const headers = readRawHeaders(request, "cookie");
	if (headers.length > 1) return false;
	if (headers.length === 0) return true;
	let count = 0;
	for (const part of headers[0].split(";")) {
		const name = part.trim().split("=", 1)[0];
		if (name === WEB_ACCESS_COOKIE_NAME || name === WEB_ACCESS_HTTP_COOKIE_NAME) count += 1;
	}
	return count <= 1;
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
	const values = readRawHeaders(request, name);
	return values.length === 1 ? values[0] : undefined;
}

function readCookie(header: string | undefined, origin: string): string | undefined {
	if (!header) return undefined;
	const expected = cookieName(origin);
	let found: string | undefined;
	for (const part of header.split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name !== expected) continue;
		if (found !== undefined || value.length === 0) return undefined;
		found = value.join("=");
	}
	return found;
}

function serveStatic(response: ServerResponse, assets: WebStaticAssets, pathname: string): void {
	const asset = assets.get(pathname);
	if (!asset) {
		sendError(response, 404, "WEB_ACCESS_NOT_FOUND", "Web page not found");
		return;
	}
	response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.contentType });
	response.end(asset.body);
}

function cookieName(origin: string): string {
	return new URL(origin).protocol === "https:" ? WEB_ACCESS_COOKIE_NAME : WEB_ACCESS_HTTP_COOKIE_NAME;
}

function cookieAttributes(origin: string): string {
	return `Path=/; ${new URL(origin).protocol === "https:" ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

function setCookie(response: ServerResponse, value: string, expiresAt: number, origin: string): void {
	response.setHeader(
		"Set-Cookie",
		`${cookieName(origin)}=${value}; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}; ${cookieAttributes(origin)}`,
	);
}

function clearCookie(response: ServerResponse, origin: string): void {
	response.setHeader("Set-Cookie", `${cookieName(origin)}=; Max-Age=0; ${cookieAttributes(origin)}`);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
		sendError(response, 413, "WEB_ACCESS_RESPONSE_LIMIT", "Response is too large");
		return;
	}
	response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
	response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
	sendJson(response, status, { error: { code, message } });
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
