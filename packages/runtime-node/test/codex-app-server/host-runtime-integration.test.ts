import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RuntimeHost } from "@vetta/runtime-core";
import { describe, it } from "vitest";
import { FileConversationOwnershipManager } from "../../src/conversation/conversation-ownership-lease.js";
import { CodexRuntimeHostBackend } from "../../src/codex-app-server/host-backend.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { hostFixture } from "./host-test-support.js";

// Workspace integration gate: real RuntimeHost, event relay, catalog and existing file ownership manager.
// Only the external Codex transport is replaced. Run with the repository's native Vitest wrapper.
describe("Codex assembly inside the actual RuntimeHost", () => {
	it("routes a full session lifecycle through Host and restores the same stable history", async () => {
		const f = await hostFixture();
		const backend = new CodexRuntimeHostBackend({ ...f.config, ownership: new FileConversationOwnershipManager() });
		const host = new RuntimeHost({ createSessionBackend: () => backend, sessionCatalog: backend.catalog });
		try {
			const { sessionId } = await host.createSession({ cwd: f.cwd, executionMode: "sandbox" });
			const started = deferred<void>();
			const unsubscribe = host.subscribe(sessionId, (event) => {
				if (event.type === "session.lifecycle" && event.phase === "agent_start") started.resolve();
			});
			const work = host.prompt(sessionId, { text: "first prompt" });
			await started.promise;
			assert.equal(host.getState(sessionId).isStreaming, true);
			f.transports[0].finish();
			assert.equal((await work).status, "completed");
			assert.equal(host.getState(sessionId).isStreaming, false);
			const path = host.getSessionPath(sessionId); assert.ok(path);
			await host.renameSessionById(sessionId, "host test");
			assert.equal((await host.listSessions(f.cwd))[0].name, "host test");
			const before = host.getFullHistory(sessionId);
			await assert.rejects(host.deleteMessage(sessionId, "item"), { code: "UNSUPPORTED" });
			await assert.rejects(host.updateSettings(sessionId, { modelKey: "native/model" }), { code: "UNSUPPORTED" });
			unsubscribe();
			await host.disposeSession(sessionId);
			await assert.rejects(readFile(`${path}.owner.lock`), { code: "ENOENT" });
			const resumed = await host.createSession({ sessionPath: path, executionMode: "sandbox" });
			assert.equal(resumed.sessionId, sessionId);
			assert.deepEqual(host.getFullHistory(sessionId), before);
			const second = host.prompt(sessionId, { text: "stop this" });
			await f.transports[1].waitFor("turn/start");
			const stop = host.abort(sessionId);
			await f.transports[1].waitFor("turn/interrupt");
			f.transports[1].finish("interrupted");
			await stop;
			assert.equal((await second).status, "cancelled");
		} finally { await host.close(); await f.cleanup(); }
	});
	it("uses the existing file lease to reject a second Host opening the same thread", async () => {
		const f = await hostFixture();
		const first = new CodexRuntimeHostBackend({ ...f.config, ownership: new FileConversationOwnershipManager() });
		const second = new CodexRuntimeHostBackend({ ...f.config, ownership: new FileConversationOwnershipManager() });
		try {
			const assembly = await first.createAssembly(f.request);
			await assert.rejects(second.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath }));
			assert.equal(f.transports.length, 1);
			await assembly.lifecycle.dispose();
			await second.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath });
			assert.equal(f.transports.length, 2);
		} finally { await first.dispose(); await second.dispose(); await f.cleanup(); }
	});
});
