import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { listCodexModelChoices, resolveCodexModel, type ExistingModelConfig } from "./model-source.js";
import { command, profile } from "./validation.js";

function config(): ExistingModelConfig {
	return { defaultModel: "gateway/local-alias", providers: { gateway: {
		displayName: "My gateway", baseUrl: "https://gateway.example/v1/", api: "openai-responses",
		credentialRef: "vault:existing", apiKey: "synthetic-secret", useProxy: false,
		headers: { "X-Tenant": "synthetic-tenant" },
		models: [{ id: "local-alias", modelId: "wire/model", name: "Existing model", defaultReasoningLevel: "high" }],
	} } };
}
const literal = (value: string) => value;
describe("reusing existing Vetta model configuration", () => {
	it("maps the configured alias to the actual request model, URL, headers and proxy selection", () => {
		const resolved = resolveCodexModel(config(), "gateway/local-alias", literal);
		assert.equal(resolved.model, "wire/model"); assert.equal(resolved.baseUrl, "https://gateway.example/v1");
		assert.equal(resolved.headers.authorization, "Bearer synthetic-secret");
		assert.equal(resolved.headers["x-tenant"], "synthetic-tenant");
		assert.equal(resolved.useProxy, false); assert.equal(resolved.reasoning, "high");
	});
	it("lists only safe metadata, without secrets, credential references or headers", () => {
		const choices = listCodexModelChoices(config());
		assert.equal(choices[0].isDefault, true); assert.equal(choices[0].modelKey, "gateway/local-alias");
		const json = JSON.stringify(choices);
		for (const secret of ["synthetic-secret", "vault:existing", "synthetic-tenant", "authorization", "headers"]) assert.equal(json.includes(secret), false);
	});
	it("preserves references whose model IDs themselves contain slashes", () => {
		const c = config(); c.providers.gateway.models![0].id = "family/model";
		assert.equal(resolveCodexModel(c, "gateway/family/model", literal).model, "wire/model");
	});
	it("does not substitute the default model when the selected provider or model was deleted", () => {
		const c = config();
		assert.throws(() => resolveCodexModel(c, "missing/local-alias", literal), { code: "MODEL_REFERENCE_MISSING" });
		c.providers.gateway.models = [];
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "MODEL_REFERENCE_MISSING" });
	});
	it("marks Chat Completions and unclassified models as unavailable rather than converting silently", () => {
		for (const api of ["openai-completions", "anthropic-messages", undefined]) {
			const c = config(); c.providers.gateway.api = api;
			assert.equal(listCodexModelChoices(c)[0].unavailable, "RESPONSES_REQUIRED");
			assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "RESPONSES_REQUIRED" });
		}
	});
	it("honors an explicit model-level Responses protocol", () => {
		const c = config(); c.providers.gateway.api = "openai-completions"; c.providers.gateway.models![0].api = "openai-responses";
		assert.equal(listCodexModelChoices(c)[0].unavailable, undefined);
	});
	it("rejects credentials in URLs, query tokens, fragments and endpoint-path confusion", () => {
		for (const url of ["https://user:secret@host/v1", "https://host/v1?key=secret", "https://host/v1#frag", "https://host/v1/responses", "file:///etc/config"]) {
			const c = config(); c.providers.gateway.baseUrl = url;
			assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal));
			assert.equal(JSON.stringify(listCodexModelChoices(c)).includes("secret"), false);
		}
	});
	it("allows local HTTP gateways but requires TLS for non-loopback addresses", () => {
		const c = config(); c.providers.gateway.baseUrl = "http://127.0.0.1:8080/v1";
		assert.equal(resolveCodexModel(c, "gateway/local-alias", literal).baseUrl, "http://127.0.0.1:8080/v1");
		c.providers.gateway.baseUrl = "http://gateway.example/v1";
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "GATEWAY_TLS_REQUIRED" });
	});
	it("uses the existing value resolver but does not execute command-based credential sources", () => {
		const c = config(); let called = false; c.providers.gateway.apiKey = "!print-secret";
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", () => { called = true; return "secret"; }), { code: "COMMAND_CREDENTIAL_UNSUPPORTED" });
		// Custom header values may be resolved before the key; the command string itself must not be resolved.
		c.providers.gateway.headers = {}; called = false;
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", () => { called = true; return "secret"; }));
		assert.equal(called, false);
		c.providers.gateway.apiKey = "ENV_KEY";
		assert.equal(resolveCodexModel(c, "gateway/local-alias", value => value === "ENV_KEY" ? "from-environment" : value).headers.authorization, "Bearer from-environment");
	});
	it("fails closed on missing, masked or invalid credentials without printing their values", () => {
		for (const key of [undefined, "***", "bad\r\nheader"]) {
			const c = config(); c.providers.gateway.apiKey = key;
			assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "CREDENTIAL_UNAVAILABLE" });
		}
	});
	it("supports explicit custom-header authentication and rejects ambiguous bearer configuration", () => {
		const c = config(); c.providers.gateway.authHeader = false;
		c.providers.gateway.headers = { "X-API-Key": "custom" };
		const r = resolveCodexModel(c, "gateway/local-alias", literal);
		assert.equal(r.headers.authorization, undefined); assert.equal(r.headers["x-api-key"], "custom");
		c.providers.gateway.authHeader = true; c.providers.gateway.headers = { Authorization: "Bearer custom" };
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "GATEWAY_AUTH_CONFLICT" });
	});
	it("rejects hop-by-hop and conflicting header names", () => {
		const cases: Record<string, string>[] = [{ Host: "other" }, { "X-Forwarded-Host": "other" }, { Foo: "a", foo: "b" }, { "Bad\nName": "a" }];
		for (const headers of cases) {
			const c = config(); c.providers.gateway.headers = headers;
			assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "GATEWAY_HEADER_UNSUPPORTED" });
		}
	});
	it("keeps persisted identity free of credentials while invalidating the in-memory credential revision", () => {
		const c = config(); const first = resolveCodexModel(c, "gateway/local-alias", literal);
		c.providers.gateway.apiKey = "rotated-secret";
		const second = resolveCodexModel(c, "gateway/local-alias", literal);
		assert.equal(first.identity, second.identity); assert.notEqual(first.revision, second.revision);
		c.providers.gateway.baseUrl = "https://different.example/v1";
		assert.notEqual(resolveCodexModel(c, "gateway/local-alias", literal).identity, first.identity);
	});
	it("does not ignore configured model overrides or unsupported reasoning modes", () => {
		const c = config(); c.providers.gateway.modelOverrides = { "local-alias": { temperature: 0.9 } };
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "MODEL_OVERRIDES_UNSUPPORTED" });
		delete c.providers.gateway.modelOverrides; c.providers.gateway.models![0].defaultReasoningLevel = "vendor-special";
		assert.throws(() => resolveCodexModel(c, "gateway/local-alias", literal), { code: "REASONING_UNSUPPORTED" });
	});
	it("preserves legacy profiles but forbids mixing a reference with an independent model override", () => {
		const p = { executable: "/codex", expectedVersion: "1.0", codexHome: "/home/codex", cwd: "/work", sandbox: "read-only" };
		assert.deepEqual(profile({ ...p, model: "legacy" }), { ...p, model: "legacy" });
		assert.deepEqual(profile({ ...p, vettaModelKey: "gateway/local-alias" }), { ...p, vettaModelKey: "gateway/local-alias" });
		assert.throws(() => profile({ ...p, model: "other", vettaModelKey: "gateway/local-alias" }), { code: "INPUT" });
		assert.deepEqual(command({ type: "models" }), { type: "models" });
		assert.throws(() => command({ type: "models", includeSecrets: true }), { code: "INPUT" });
	});
});
