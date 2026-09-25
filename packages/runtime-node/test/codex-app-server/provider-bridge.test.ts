import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { afterEach, describe, it } from "vitest";
import { codexGatewayThreadConfig, startCodexProviderBridge, type CodexGatewaySource, type CodexGatewayTarget } from "../../src/codex-app-server/provider-bridge.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const initial = (): CodexGatewayTarget => ({ identity: "public-settings-identity", revision: "live-secret-revision",
	model: "wire/model", baseUrl: "https://gateway.example/v1", headers: { authorization: "Bearer upstream-secret", "x-tenant": "tenant-secret" } });
async function fixture(fetcher: typeof fetch = async () => new Response("data: completed\n\n", { headers: { "content-type": "text/event-stream" } })) {
	let target = initial(); let invalidate = () => {}; let calls = 0;
	const requests: { url: string; init?: RequestInit }[] = [];
	const source: CodexGatewaySource = { resolve: async () => target,
		subscribe: fn => { invalidate = fn; return () => { invalidate = () => {}; }; },
		fetch: async (input, init) => { calls++; requests.push({ url: String(input), init }); return fetcher(input, init); } };
	const bridge = await startCodexProviderBridge(source); cleanups.push(() => bridge.close());
	const post = (path = "/responses", body: unknown = { model: "wire/model", input: [] }, headers: Record<string, string> = {}) => fetch(`${bridge.provider.baseUrl}${path}`, {
		method: "POST", headers: { Authorization: `Bearer ${bridge.provider.bearerToken}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
	});
	return { bridge, post, requests, count: () => calls, change: (patch: Partial<CodexGatewayTarget>) => { target = { ...target, ...patch }; }, invalidate: () => invalidate() };
}
describe("authenticated Codex loopback provider bridge", () => {
	it("streams the response while keeping real gateway credentials out of the Codex provider configuration", async () => {
		const f = await fixture(); const res = await f.post();
		assert.equal(await res.text(), "data: completed\n\n");
		assert.equal(f.requests[0].url, "https://gateway.example/v1/responses");
		assert.equal(new Headers(f.requests[0].init?.headers).get("authorization"), "Bearer upstream-secret");
		const config = codexGatewayThreadConfig(f.bridge.provider);
		assert.equal(config.model, "wire/model"); assert.equal(config.modelProvider, f.bridge.provider.id);
		assert.equal(JSON.stringify(config).includes("upstream-secret"), false);
		assert.equal(JSON.stringify(config).includes("tenant-secret"), false);
		const p = config.config.model_providers[config.modelProvider];
		assert.equal(p.requires_openai_auth, false); assert.equal(p.supports_websockets, false);
		assert.equal(p.request_max_retries, 0); assert.equal(p.stream_max_retries, 0);
	});
	it("can continue with tool results and compact through the same selected gateway without replaying requests", async () => {
		const f = await fixture(async () => new Response('{"output":[]}', { headers: { "content-type": "application/json" } }));
		for (const input of [[{ role: "user", content: "work" }], [{ type: "function_call_output", call_id: "call", output: "done" }]]) {
			const r = await f.post("/responses", { model: "wire/model", input }); assert.equal(r.status, 200); await r.text();
		}
		const compact = await f.post("/responses/compact"); assert.equal(compact.status, 200); await compact.text();
		assert.equal(f.count(), 3); assert.ok(f.requests.at(-1)?.url.endsWith("/responses/compact"));
	});
	it("rejects unauthenticated requests and requests from a browser before resolving an upstream call", async () => {
		const f = await fixture();
		const cases: Record<string, string>[] = [{ Authorization: "Bearer wrong" }, { Origin: "https://untrusted.example" }, { "Sec-Fetch-Site": "cross-site" }];
		for (const headers of cases) {
			const r = await f.post("/responses", undefined, headers); assert.equal(r.status, 403); await r.text();
		}
		assert.equal(f.count(), 0);
	});
	it("cannot be used as an arbitrary proxy or to call a different model", async () => {
		const f = await fixture();
		for (const path of ["/models", "/responses?target=https://other.example", "/responses/../models"]) { const r = await f.post(path); assert.equal(r.status, 502); await r.text(); }
		const wrong = await f.post("/responses", { model: "other" }); assert.match(await wrong.text(), /GATEWAY_MODEL_MISMATCH/);
		assert.equal(f.count(), 0);
	});
	it("rejects upstream redirects without forwarding credentials to the redirected host", async () => {
		const f = await fixture(async () => new Response(null, { status: 307, headers: { location: "https://other.example" } }));
		const r = await f.post(); assert.match(await r.text(), /GATEWAY_REDIRECT_REJECTED/);
		assert.equal(f.count(), 1); assert.equal(f.requests[0].init?.redirect, "manual");
	});
	it("sanitizes upstream HTTP errors instead of leaking reflected keys or raw provider messages", async () => {
		const f = await fixture(async () => new Response("upstream-secret tenant-secret", { status: 401 }));
		const r = await f.post(); assert.equal(r.status, 401); const text = await r.text();
		assert.match(text, /GATEWAY_HTTP_401/); assert.equal(text.includes("secret"), false); assert.equal(f.count(), 1);
	});
	it("refuses new requests after settings or credentials change; it never switches the target silently", async () => {
		const f = await fixture();
		f.change({ revision: "new-key-revision", headers: { authorization: "Bearer new" } });
		const r = await f.post(); assert.match(await r.text(), /MODEL_CONFIGURATION_CHANGED/);
		assert.equal(f.count(), 0); await assert.rejects(f.bridge.assertCurrent(), { code: "MODEL_CONFIGURATION_CHANGED" });
	});
	it("provider removal or a settings notification invalidates the already open bridge", async () => {
		const f = await fixture(); f.invalidate();
		const r = await f.post(); assert.match(await r.text(), /MODEL_CONFIGURATION_CHANGED/); assert.equal(f.count(), 0);
	});
	it("shutdown aborts an in-flight gateway request and is idempotent", async () => {
		let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
		let signal: AbortSignal | null | undefined;
		const f = await fixture(async (_input, init) => {
			signal = init?.signal; entered();
			return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("raw secret error")), { once: true }));
		});
		const work = f.post().then(r => r.text(), () => "disconnected"); await started;
		const closing = f.bridge.close(); assert.equal(f.bridge.close(), closing); await closing; await work;
		assert.equal(signal?.aborted, true); await assert.rejects(f.bridge.assertCurrent(), { code: "GATEWAY_CLOSED" });
	});
	it("an invalidation aborts existing streams rather than allowing a stale credential to start more work", async () => {
		let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
		let signal: AbortSignal | null | undefined;
		const f = await fixture(async (_input, init) => {
			signal = init?.signal; entered(); return new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("revoked")), { once: true }));
		});
		const work = f.post(); await started; f.invalidate(); const r = await work;
		assert.equal(signal?.aborted, true); assert.equal(r.status, 502); await r.text();
	});
	it("executes over two actual HTTP servers, preserving streaming bytes", async () => {
		let auth: string | undefined;
		const upstream = createServer(async (req, res) => {
			auth = req.headers.authorization;
			for await (const _part of req) { /* Consume request before sending fixture output. */ }
			res.writeHead(200, { "content-type": "text/event-stream" });
			const bytes = Buffer.from('data: {"text":"你好"}\n\n');
			const cut = bytes.indexOf(Buffer.from("你好")) + 1;
			res.write(bytes.subarray(0, cut)); res.end(bytes.subarray(cut));
		});
		upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
		cleanups.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
		const address = upstream.address(); assert.ok(address && typeof address !== "string");
		const t = { ...initial(), baseUrl: `http://127.0.0.1:${address.port}/v1` };
		const bridge = await startCodexProviderBridge({ resolve: async () => t, fetch }); cleanups.push(() => bridge.close());
		const result = await fetch(`${bridge.provider.baseUrl}/responses`, { method: "POST", headers: {
			Authorization: `Bearer ${bridge.provider.bearerToken}`, "content-type": "application/json" }, body: JSON.stringify({ model: t.model, input: [] }) });
		assert.equal(await result.text(), 'data: {"text":"你好"}\n\n'); assert.equal(auth, "Bearer upstream-secret");
	});
	it("rejects an arbitrary destination disguised as a runtime gateway binding", () => {
		assert.throws(() => codexGatewayThreadConfig({ id: `vetta_${"0".repeat(24)}`, baseUrl: "https://evil.example/v1", bearerToken: "0".repeat(64), model: "model" }), { code: "GATEWAY_BINDING_INVALID" });
	});
	it("client disconnect aborts the upstream HTTP stream rather than leaving a model request running", async () => {
		let confirmClosed!: () => void;
		const upstreamClosed = new Promise<void>(resolve => { confirmClosed = resolve; });
		const upstream = createServer(async (request, response) => {
			for await (const _part of request) { /* Consume the request. */ }
			response.on("close", confirmClosed);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: partial\n\n");
		});
		upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
		cleanups.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
		const address = upstream.address(); assert.ok(address && typeof address !== "string");
		const target = { ...initial(), baseUrl: `http://127.0.0.1:${address.port}/v1` };
		const bridge = await startCodexProviderBridge({ resolve: async () => target, fetch }); cleanups.push(() => bridge.close());
		await new Promise<void>((resolve, reject) => {
			const request = httpRequest(`${bridge.provider.baseUrl}/responses`, {
				method: "POST", headers: { Authorization: `Bearer ${bridge.provider.bearerToken}`, "content-type": "application/json" },
			}, response => {
				response.once("data", () => { response.destroy(); resolve(); });
				response.on("error", () => undefined);
			});
			request.on("error", reject);
			request.end(JSON.stringify({ model: target.model, input: [] }));
		});
		await upstreamClosed;
	});
	it("takes an immutable initial identity even if a source mutates its returned object", async () => {
		const target = initial();
		const bridge = await startCodexProviderBridge({ resolve: async () => target, fetch }); cleanups.push(() => bridge.close());
		target.revision = "changed-in-place";
		await assert.rejects(bridge.assertCurrent(), { code: "MODEL_CONFIGURATION_CHANGED" });
	});

});
