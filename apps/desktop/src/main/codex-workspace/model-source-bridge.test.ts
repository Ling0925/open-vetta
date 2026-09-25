import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it } from "vitest";
import { startCodexProviderBridge } from "@vetta/runtime-node/codex-app-server";
import { listCodexModelChoices, resolveCodexModel, type ExistingModelConfig } from "./model-source.js";

/** Continuous workflow: existing configuration -> exact wire model -> HTTP tool loop -> key rotation. */
describe("reusing existing Vetta models over real loopback HTTP", () => {
	it("uses the selected alias, headers and credential, then stops on credential changes until explicitly reopened", async () => {
		const observed: { authorization?: string; tenant?: string; body: Record<string, unknown> }[] = [];
		const upstream = createServer(async (request, response) => {
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			observed.push({ authorization: request.headers.authorization, tenant: String(request.headers["x-tenant"]),
				body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown> });
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
		});
		upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
		const address = upstream.address(); assert.ok(address && typeof address !== "string");
		const config: ExistingModelConfig = { defaultModel: "gateway/friendly", providers: { gateway: {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-responses", credentialRef: "vault-reference",
			apiKey: "synthetic-first-key", headers: { "X-Tenant": "synthetic-tenant" },
			models: [{ id: "friendly", modelId: "real/model-id", name: "Configured model" }],
		} } };
		const source = { resolve: async () => resolveCodexModel(config, "gateway/friendly", value => value), fetch };
		let bridge: Awaited<ReturnType<typeof startCodexProviderBridge>> | undefined;
		try {
			const choices = listCodexModelChoices(config);
			assert.equal(choices[0].modelKey, config.defaultModel);
			assert.equal(JSON.stringify(choices).includes("synthetic-first-key"), false);
			bridge = await startCodexProviderBridge(source);
			const post = (body: Record<string, unknown>) => fetch(`${bridge!.provider.baseUrl}/responses`, {
				method: "POST", headers: { Authorization: `Bearer ${bridge!.provider.bearerToken}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			for (const input of [[{ role: "user", content: "inspect" }], [{ type: "function_call_output", call_id: "tool-1", output: "done" }]]) {
				const result = await post({ model: bridge.provider.model, input, stream: true });
				assert.equal(result.status, 200); assert.match(await result.text(), /response.completed/);
			}
			assert.deepEqual(observed.map(request => request.body.model), ["real/model-id", "real/model-id"]);
			assert.equal(observed[0].authorization, "Bearer synthetic-first-key");
			assert.equal(observed[1].tenant, "synthetic-tenant");
			const identity = bridge.identity;
			const localToken = bridge.provider.bearerToken;
			config.providers.gateway.apiKey = "synthetic-second-key";
			const blocked = await post({ model: bridge.provider.model, input: [] });
			assert.match(await blocked.text(), /MODEL_CONFIGURATION_CHANGED/);
			assert.equal(observed.length, 2);
			await bridge.close();
			bridge = await startCodexProviderBridge(source);
			assert.equal(bridge.identity, identity);
			assert.notEqual(bridge.provider.bearerToken, localToken);
			const resumed = await post({ model: bridge.provider.model, input: [] }); await resumed.text();
			assert.equal(observed.at(-1)?.authorization, "Bearer synthetic-second-key");
		} finally {
			await bridge?.close();
			await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
		}
	});
	it("deleting the selected provider blocks subsequent traffic rather than using the new default", async () => {
		const config: ExistingModelConfig = { defaultModel: "gateway/one", providers: {
			gateway: { api: "openai-responses", baseUrl: "https://gateway.example/v1", apiKey: "synthetic-key", models: [{ id: "one" }] },
		} };
		let calls = 0;
		const bridge = await startCodexProviderBridge({ resolve: async () => resolveCodexModel(config, "gateway/one", value => value),
			fetch: async () => { calls++; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
		try {
			delete config.providers.gateway;
			config.providers.other = { api: "openai-responses", baseUrl: "https://other.example/v1", apiKey: "another-key", models: [{ id: "two" }] };
			config.defaultModel = "other/two";
			await assert.rejects(bridge.assertCurrent(), { code: "MODEL_REFERENCE_MISSING" });
			const result = await fetch(`${bridge.provider.baseUrl}/responses`, { method: "POST", headers: {
				Authorization: `Bearer ${bridge.provider.bearerToken}`, "content-type": "application/json" }, body: JSON.stringify({ model: "one", input: [] }) });
			assert.equal(result.status, 502); await result.text(); assert.equal(calls, 0);
		} finally { await bridge.close(); }
	});
});
