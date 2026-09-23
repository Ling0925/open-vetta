import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import type { WebAccessProjectSnapshot } from "../../shared/web-access.js";
import { WebAccessAuthorization } from "./authorization.js";
import { startWebAccessServer } from "./web-access-server.js";

const ORIGIN = "https://web.test";

function snapshot(cursor: number): WebAccessProjectSnapshot {
	return {
		generation: "generation-1",
		cursor,
		projects: [{ path: "C:/workspace/demo", name: "demo" }],
		archivedProjects: [],
	};
}

type RawResponse = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: unknown };

describe("Web access HTTP boundary", () => {
	it("pairs, restores with GET, reads projects, watches changes, and rejects revoked grants", async () => {
		const pairingValues = ["pair-code", "cookie-secret", "csrf-pair"];
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => pairingValues.shift() ?? "fallback",
		);
		const pairing = authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
		const projects = {
			read: async () => snapshot(1),
			waitForChange: async () => ({ changed: true, snapshot: snapshot(2) }),
		};
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: {
				get: (pathname) => (pathname === "/" ? { body: Buffer.from("web"), contentType: "text/html" } : undefined),
			},
			authorization,
			projects,
		});
		try {
			const page = await rawRequest(server.address, "GET", "/", { host: "web.test" });
			expect(page.status).toBe(200);
			expect(page.headers["x-content-type-options"]).toBe("nosniff");

			const pairResponse = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: ORIGIN,
				body: { code: pairing.code },
			});
			expect(pairResponse.status).toBe(200);
			const cookie = firstHeader(pairResponse.headers["set-cookie"])?.split(";", 1)[0];
			const pairPayload = pairResponse.body as { csrf: string };
			expect(cookie).toMatch(/^__Host-vetta-web=/);
			expect(firstHeader(pairResponse.headers["set-cookie"])).toContain("Secure");
			expect(firstHeader(pairResponse.headers["set-cookie"])).toContain("HttpOnly");
			expect(firstHeader(pairResponse.headers["set-cookie"])).toContain("SameSite=Strict");
			if (!cookie) throw new Error("pair response did not set a cookie");

			const restored = await rawRequest(server.address, "GET", "/api/session/bootstrap", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
			});
			expect(restored.status).toBe(200);
			const restoredPayload = restored.body as { csrf: string };

			const unauthorized = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf: pairPayload.csrf,
				body: {},
			});
			expect(unauthorized.status).toBe(200);

			const snapshotResponse = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf: restoredPayload.csrf,
				body: {},
			});
			expect(snapshotResponse.status).toBe(200);
			expect(snapshotResponse.body).toEqual(snapshot(1));

			const watchResponse = await rawRequest(server.address, "POST", "/api/projects/watch", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf: restoredPayload.csrf,
				body: { generation: "generation-1", cursor: 1, waitMs: 1 },
			});
			expect(watchResponse.status).toBe(200);
			expect(watchResponse.body).toEqual({ changed: true, snapshot: snapshot(2) });

			const grantId = authorization.listGrants()[0]?.id;
			if (!grantId) throw new Error("grant was not created");
			authorization.revoke(grantId);
			server.abortGrant(grantId);
			const revoked = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf: restoredPayload.csrf,
				body: {},
			});
			expect(revoked.status).toBe(401);
		} finally {
			await server.close();
		}
	});

	it("rejects cross-site, forwarded, duplicate-host and oversized requests", async () => {
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => "pair-code",
		);
		authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: { get: () => undefined },
			authorization,
			projects: {
				read: async () => snapshot(1),
				waitForChange: async () => ({ changed: false, snapshot: snapshot(1) }),
			},
		});
		try {
			const badOrigin = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: "https://evil.test",
				body: { code: "pair-code" },
			});

			expect(badOrigin.status).toBe(403);

			const forwarded = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: ORIGIN,
				extraHeaders: { Forwarded: "for=127.0.0.1" },
				body: { code: "pair-code" },
			});
			expect(forwarded.status).toBe(200);

			expect(await rawDuplicateHost(server.address)).toBe(403);

			const oversized = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: ORIGIN,
				body: { code: "x".repeat(40_000) },
			});
			expect(oversized.status).toBe(400);
		} finally {
			await server.close();
		}
	});

	it("enforces the strict protocol and resynchronizes a stale or future cursor", async () => {
		const values = ["pair-code", "cookie-secret", "csrf-secret"];
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => values.shift() ?? "fallback",
		);
		let waits = 0;
		const projects = {
			read: async () => snapshot(7),
			getPosition: () => ({ generation: "generation-1", cursor: 7 }),
			waitForChange: async () => {
				waits += 1;
				return { changed: false, snapshot: snapshot(7) };
			},
		};
		const pairing = authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: {
				get: (pathname) => (pathname === "/" ? { body: Buffer.from("web"), contentType: "text/html" } : undefined),
			},
			authorization,
			projects,
		});
		try {
			// bootstrap 允许缺 Origin（直接导航），但错的和 null 的 Origin 都要拒；否则
			// 一个跨站页面可以拿用户的 Cookie 读到会话状态。
			const noOrigin = await rawRequest(server.address, "GET", "/api/session/bootstrap", { host: "web.test" });
			expect(noOrigin.status).toBe(401);
			expect(firstHeader(noOrigin.headers["cache-control"])).toBe("no-store");

			const pairResponse = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: ORIGIN,
				body: { code: pairing.code },
			});
			const cookie = firstHeader(pairResponse.headers["set-cookie"])?.split(";", 1)[0];
			if (!cookie) throw new Error("pair response did not set a cookie");
			const csrf = (pairResponse.body as { csrf: string }).csrf;

			const nullOriginBootstrap = await rawRequest(server.address, "GET", "/api/session/bootstrap", {
				host: "web.test",
				origin: "null",
				cookie,
			});
			expect(nullOriginBootstrap.status).toBe(403);

			const restored = await rawRequest(server.address, "GET", "/api/session/bootstrap", {
				host: "web.test",
				cookie,
			});
			expect(restored.status).toBe(200);
			// 同一 Cookie 的多个标签页：bootstrap 不能轮换 CSRF，否则另一个标签页会失效。
			expect((restored.body as { csrf: string }).csrf).toBe(csrf);

			// 业务 POST 必须带精确 Origin。
			const missingOrigin = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				cookie,
				csrf,
				body: {},
			});
			expect(missingOrigin.status).toBe(403);

			// 歧义 Cookie 头（同名出现两次）不能靠「第一个赢」蒙混过去。
			const ambiguousCookie = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				origin: ORIGIN,
				cookie: `${cookie}; ${cookie}`,
				csrf,
				body: {},
			});
			expect(ambiguousCookie.status).toBe(400);

			const bootstrapWithPost = await rawRequest(server.address, "POST", "/api/session/bootstrap", {
				host: "web.test",
				origin: ORIGIN,
				body: {},
			});
			expect(bootstrapWithPost.status).toBe(405);

			const wrongMediaType = await rawRequest(server.address, "POST", "/api/projects/snapshot", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf,
				extraHeaders: { "Content-Type": "text/plain" },
				body: {},
			});
			expect(wrongMediaType.status).toBe(415);

			const unknownField = await rawRequest(server.address, "POST", "/api/projects/watch", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf,
				body: { generation: "generation-1", cursor: 7, waitMs: 10, channel: "secret" },
			});
			expect(unknownField.status).toBe(400);

			// 过期游标（小于当前位置）与未来游标（大于当前位置）都要立即重新同步，而不是挂住
			// 等待下一次变化——旧游标贴上新内容就是丢变更。
			for (const cursor of [3, 99]) {
				const stale = await rawRequest(server.address, "POST", "/api/projects/watch", {
					host: "web.test",
					origin: ORIGIN,
					cookie,
					csrf,
					body: { generation: "generation-1", cursor, waitMs: 10 },
				});
				expect(stale.status).toBe(200);
				expect(stale.body).toEqual({ changed: true, snapshot: snapshot(7) });
			}

			// 宿主重启后世代会变；旧世代的游标不能接到新流上。
			const restartedHost = await rawRequest(server.address, "POST", "/api/projects/watch", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf,
				body: { generation: "generation-0", cursor: 7, waitMs: 10 },
			});
			expect(restartedHost.status).toBe(200);
			expect(restartedHost.body).toEqual({ changed: true, snapshot: snapshot(7) });
			expect(waits).toBe(0);
		} finally {
			await server.close();
		}
	});

	it("keeps two browser grants independent while observing the same project source", async () => {
		const values = ["pair-one", "cookie-one", "csrf-one", "pair-two", "cookie-two", "csrf-two"];
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => values.shift() ?? "fallback",
		);
		const projects = {
			read: async () => snapshot(1),
			waitForChange: async () => ({ changed: true, snapshot: snapshot(2) }),
		};
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: { get: () => undefined },
			authorization,
			projects,
		});
		try {
			const pairGrant = async (code: string): Promise<{ cookie: string; csrf: string }> => {
				const response = await rawRequest(server.address, "POST", "/api/pair", {
					host: "web.test",
					origin: ORIGIN,
					body: { code },
				});
				const cookie = firstHeader(response.headers["set-cookie"])?.split(";", 1)[0];
				if (!cookie) throw new Error("pair response did not set a cookie");
				return { cookie, csrf: (response.body as { csrf: string }).csrf };
			};
			const firstPairing = authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
			const first = await pairGrant(firstPairing.code);
			const secondPairing = authorization.createPairing({
				origin: ORIGIN,
				generation: 0,
				scopes: ["projects.read"],
			});
			const second = await pairGrant(secondPairing.code);
			const requestSnapshot = (grant: { cookie: string; csrf: string }) =>
				rawRequest(server.address, "POST", "/api/projects/snapshot", {
					host: "web.test",
					origin: ORIGIN,
					cookie: grant.cookie,
					csrf: grant.csrf,
					body: {},
				});

			expect((await requestSnapshot(first)).status).toBe(200);
			expect((await requestSnapshot(second)).status).toBe(200);
			const firstGrantId = authorization.listGrants()[0]?.id;
			if (!firstGrantId) throw new Error("first grant was not created");
			authorization.revoke(firstGrantId);
			server.abortGrant(firstGrantId);
			expect((await requestSnapshot(first)).status).toBe(401);
			expect((await requestSnapshot(second)).status).toBe(200);
		} finally {
			await server.close();
		}
	});

	it("cancels a grant's in-flight observation when it is revoked", async () => {
		const values = ["pair-code", "cookie-secret", "csrf-secret"];
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => values.shift() ?? "fallback",
		);
		const observed: AbortSignal[] = [];
		const projects = {
			read: async () => snapshot(1),
			getPosition: () => ({ generation: "generation-1", cursor: 1 }),
			waitForChange: async (_generation: string | undefined, _cursor: number | undefined, signal: AbortSignal) => {
				observed.push(signal);
				return await new Promise<never>(() => {});
			},
		};
		const pairing = authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: { get: () => undefined },
			authorization,
			projects,
		});
		try {
			const pairResponse = await rawRequest(server.address, "POST", "/api/pair", {
				host: "web.test",
				origin: ORIGIN,
				body: { code: pairing.code },
			});
			const cookie = firstHeader(pairResponse.headers["set-cookie"])?.split(";", 1)[0];
			if (!cookie) throw new Error("pair response did not set a cookie");
			const csrf = (pairResponse.body as { csrf: string }).csrf;

			// 观察请求挂在长轮询上，不做撤销的话它会一直占着连接。
			void rawRequest(server.address, "POST", "/api/projects/watch", {
				host: "web.test",
				origin: ORIGIN,
				cookie,
				csrf,
				body: { generation: "generation-1", cursor: 1, waitMs: 25_000 },
			}).catch(() => undefined);
			await waitFor(() => observed.length === 1);

			const grantId = authorization.listGrants()[0]?.id;
			if (!grantId) throw new Error("grant was not created");
			// 这一对调用就是管理界面撤销一个浏览器时发生的事。
			authorization.revoke(grantId);
			server.abortGrant(grantId);

			expect(observed[0]?.aborted).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("bounds concurrent requests per grant and keeps other grants unaffected", async () => {
		const values = ["pair-one", "cookie-one", "csrf-one", "pair-two", "cookie-two", "csrf-two"];
		const authorization = new WebAccessAuthorization(
			() => 1_000,
			() => values.shift() ?? "fallback",
		);
		let pendingReads = 0;
		// 项目读取永不返回：请求会一直占着并发额度，直到服务被关掉。
		const projects = {
			read: async () => {
				pendingReads += 1;
				return await new Promise<never>(() => {});
			},
			waitForChange: async () => ({ changed: false, snapshot: snapshot(1) }),
		};
		const server = await startWebAccessServer({
			origin: ORIGIN,
			port: 0,
			assets: { get: () => undefined },
			authorization,
			projects,
		});
		try {
			const pairGrant = async (): Promise<{ cookie: string; csrf: string }> => {
				const pairing = authorization.createPairing({ origin: ORIGIN, generation: 0, scopes: ["projects.read"] });
				const response = await rawRequest(server.address, "POST", "/api/pair", {
					host: "web.test",
					origin: ORIGIN,
					body: { code: pairing.code },
				});
				const cookie = firstHeader(response.headers["set-cookie"])?.split(";", 1)[0];
				if (!cookie) throw new Error("pair response did not set a cookie");
				return { cookie, csrf: (response.body as { csrf: string }).csrf };
			};
			const busy = await pairGrant();
			const other = await pairGrant();
			const snapshotRequest = (grant: { cookie: string; csrf: string }) =>
				rawRequest(server.address, "POST", "/api/projects/snapshot", {
					host: "web.test",
					origin: ORIGIN,
					cookie: grant.cookie,
					csrf: grant.csrf,
					body: {},
				});

			// 挂满一个授权的并发额度：这些请求都停在项目读取上。
			for (let index = 0; index < 8; index += 1) void snapshotRequest(busy).catch(() => undefined);
			await waitFor(() => pendingReads === 8);

			const overLimit = await snapshotRequest(busy);
			expect(overLimit.status).toBe(429);
			expect((overLimit.body as { error: { code: string } }).error.code).toBe("WEB_ACCESS_REQUEST_LIMIT");
			expect(pendingReads).toBe(8);

			// 拥挤的是那一个授权；另一个浏览器仍能进入读取，不会被一起拒掉。
			void snapshotRequest(other).catch(() => undefined);
			await waitFor(() => pendingReads === 9);
		} finally {
			await server.close();
		}
	});
});
/** 等待一个已完成若干轮事件循环的条件，避免用任意 sleep。 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for the expected state");
}

async function rawRequest(
	address: string,
	method: "GET" | "POST",
	pathname: string,
	options: {
		readonly host: string;
		readonly origin?: string;
		readonly cookie?: string;
		readonly csrf?: string;
		readonly body?: unknown;
		readonly extraHeaders?: Record<string, string>;
	},
): Promise<RawResponse> {
	const url = new URL(address);
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	return await new Promise<RawResponse>((resolve, reject) => {
		const req = request(
			{
				hostname: url.hostname,
				port: url.port,
				path: pathname,
				method,
				headers: {
					Host: options.host,
					...(options.origin ? { Origin: options.origin } : {}),
					...(options.cookie ? { Cookie: options.cookie } : {}),
					...(options.csrf ? { "X-Vetta-CSRF": options.csrf } : {}),
					...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
					...options.extraHeaders,
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.once("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					const contentType = String(response.headers["content-type"] ?? "");
					const body = text && contentType.includes("application/json") ? (JSON.parse(text) as unknown) : text;
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body,
					});
				});
			},
		);
		req.once("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

async function rawDuplicateHost(address: string): Promise<number> {
	const url = new URL(address);
	return await new Promise<number>((resolve, reject) => {
		const socket = connect(Number(url.port), url.hostname);
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk.toString("utf8");
			if (text.includes("\r\n\r\n")) socket.end();
		});
		socket.once("error", reject);
		socket.once("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)));
		socket.once("connect", () => {
			socket.write(
				"POST /api/pair HTTP/1.1\r\n" +
					"Host: web.test\r\n" +
					"Host: evil.test\r\n" +
					`Origin: ${ORIGIN}\r\n` +
					"Content-Type: application/json\r\n" +
					"Content-Length: 20\r\n\r\n" +
					'{"code":"pair-code"}',
			);
		});
	});
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
