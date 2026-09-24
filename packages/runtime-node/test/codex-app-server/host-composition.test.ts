import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeHostSessionBackend, RuntimeSessionCatalog } from "@vetta/runtime-core";
import { describe, it } from "vitest";
import { createCodexRuntimeHostIntegration } from "../../src/codex-app-server/host-composition.js";
import { hostFixture } from "./host-test-support.js";

async function fixture(defaultRuntime?: "native" | "codex") {
	const f = await hostFixture();
	let nativeCalls = 0;
	const nativeError = new Error("Native execution boundary selected");
	const path = join(f.root, "native.jsonl");
	const backend: RuntimeHostSessionBackend = { createAssembly: async () => { nativeCalls += 1; throw nativeError; } };
	const catalog: RuntimeSessionCatalog = {
		ownsSession: async (value) => value === path, listProjects: async () => [], listSessions: async () => [],
		renameSession: async () => { throw new Error("Not used by this test"); },
		deleteSessionArtifacts: async () => { throw new Error("Not used by this test"); },
	};
	const access = { readHistory: true, resume: true, rename: true, delete: true };
	const integration = createCodexRuntimeHostIntegration({ ...f.config, defaultRuntime,
		native: { backend, catalog, accessResolver: { resolve: async () => access } } });
	return { ...f, integration, nativeError, path, access, calls: () => nativeCalls,
		cleanup: async () => { await integration.sessionBackend.dispose(); await f.cleanup(); } };
}

describe("existing catalog routing with the Codex backend", () => {
	it("preserves Native as the default for new sessions unless explicitly selected", async () => {
		const f = await fixture();
		try {
			await assert.rejects(f.integration.sessionBackend.createAssembly(f.request), (error) => error === f.nativeError);
			assert.equal(f.calls(), 1); assert.equal(f.transports.length, 0);
		} finally { await f.cleanup(); }
	});
	it("Codex default still sends old Native paths to Native and resumes Codex by its owner", async () => {
		const f = await fixture("codex");
		try {
			const assembly = await f.integration.sessionBackend.createAssembly(f.request);
			await assert.rejects(f.integration.sessionBackend.createAssembly({ ...f.request, sessionPath: f.path }),
				(error) => error === f.nativeError);
			const path = assembly.lifecycle.sessionPath; assert.ok(path);
			await assembly.lifecycle.dispose();
			const resumed = await f.integration.sessionBackend.createAssembly({ ...f.request, sessionPath: path });
			assert.equal(resumed.lifecycle.sessionId, assembly.lifecycle.sessionId);
			assert.equal(f.calls(), 1);
		} finally { await f.cleanup(); }
	});
	it("a missing or damaged Codex record never falls through to the Native backend", async () => {
		const f = await fixture();
		try {
			const path = await f.integration.codexBackend.catalog.pathFor("missing");
			await assert.rejects(f.integration.sessionBackend.createAssembly({ ...f.request, sessionPath: path }));
			await writeFile(path, "{corrupt");
			await assert.rejects(f.integration.sessionBackend.createAssembly({ ...f.request, sessionPath: path }));
			assert.equal(f.calls(), 0); assert.equal(f.transports.length, 0);
		} finally { await f.cleanup(); }
	});
	it("exposes offline access honestly without allowing deletion or the Native file reader", async () => {
		const f = await fixture();
		try {
			const path = await f.integration.codexBackend.catalog.pathFor("codex");
			assert.deepEqual(await f.integration.sessionAccessResolver.resolve(path), {
				readHistory: false, resume: true, rename: true, delete: false,
			});
			assert.deepEqual(await f.integration.sessionAccessResolver.resolve(f.path), f.access);
		} finally { await f.cleanup(); }
	});
});
