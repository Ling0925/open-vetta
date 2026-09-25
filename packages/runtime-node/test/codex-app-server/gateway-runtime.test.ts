import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { startCodexProviderBridge } from "../../src/codex-app-server/provider-bridge.js";
import { openCodexAppServerSession } from "../../src/codex-app-server/runtime.js";
const executable = fileURLToPath(new URL("./gateway-runtime-fixture.mjs", import.meta.url));

describe("Codex runtime binds a custom provider through the public startup path", () => {
	it("applies the provider to both create and resume without requiring OpenAI authentication", async () => {
		const root = await mkdtemp(join(tmpdir(), "vetta-codex-gateway-"));
		const cwd = join(root, "workspace"); const codexHome = join(root, "home");
		await Promise.all([mkdir(cwd), mkdir(codexHome)]);
		let calls = 0;
		const bridge = await startCodexProviderBridge({ resolve: async () => ({ identity: "selected", revision: "key-v1", model: "wire-model",
			baseUrl: "https://gateway.example/v1", headers: { authorization: "Bearer synthetic-upstream-key" } }),
			fetch: async (_url, init) => {
				calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-upstream-key");
				return new Response('{"output":[]}', { headers: { "content-type": "application/json" } });
			} });
		try {
			const options = { executable: process.execPath, executableArgs: [executable], expectedVersion: "0.0.0-test", cwd, codexHome, gateway: bridge.provider };
			const first = await openCodexAppServerSession(options);
			try { const run = await first.startTurn({ text: "test" }); assert.equal((await run.completed).status, "completed"); }
			finally { await first.close(); }
			const resumed = await openCodexAppServerSession({ ...options, threadId: "gateway-thread" });
			try { const run = await resumed.startTurn({ text: "follow up" }); assert.equal((await run.completed).status, "completed"); }
			finally { await resumed.close(); }
			assert.equal(calls, 2);
		} finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
	});
	it("refuses to send any turn if Codex returns a different model/provider binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "vetta-codex-gateway-"));
		let calls = 0;
		const bridge = await startCodexProviderBridge({ resolve: async () => ({ identity: "selected", revision: "key-v1", model: "wire-model",
			baseUrl: "https://gateway.example/v1", headers: {} }), fetch: async () => { calls++; return new Response("{}"); } });
		try {
			await assert.rejects(openCodexAppServerSession({ executable: process.execPath, executableArgs: [executable, "mismatch"],
				expectedVersion: "0.0.0-test", cwd: root, codexHome: root, gateway: bridge.provider }), { code: "PROVIDER_MISMATCH" });
			assert.equal(calls, 0);
		} finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
	});
});
