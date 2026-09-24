import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import type { SessionEvent } from "@vetta/runtime-core";
import { CodexRuntimeHostBackend } from "../../src/codex-app-server/host-backend.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import { hostFixture } from "./host-test-support.js";
const executable = fileURLToPath(new URL("./host-fixture-app-server.mjs", import.meta.url));

async function processFixture() {
	const f = await hostFixture();
	const backend = new CodexRuntimeHostBackend({ ...f.config, connect: undefined,
		profile: { ...f.config.profile, executableArgs: [executable], shutdownTimeoutMs: 1000 } });
	return { ...f, backend, cleanup: async () => { await backend.dispose(); await f.cleanup(); } };
}

describe("Codex RuntimeHost backend over a real stdio process", () => {
	it("uses the public assembly for send → tools → stop → follow-up → rename → close → resume", async () => {
		const f = await processFixture();
		try {
			const assembly = await f.backend.createAssembly(f.request);
			const events: SessionEvent[] = [];
			assembly.corePorts.eventStream.subscribe((event) => events.push(event));
			assert.equal((await assembly.corePorts.turnControl.prompt({ text: "hello" }))?.status, "completed");
			assert.equal(assembly.corePorts.stateReader.readMessages().filter((message) => message.role === "user").length, 1);
			assert.ok(events.some((event) => event.type === "tool.end" && !event.isError));
			assert.ok(events.some((event) => event.type === "message.delta" && event.delta === "完整回复"));
			const started = deferred<void>();
			const unsubscribe = assembly.corePorts.eventStream.subscribe((event) => {
				if (event.type === "session.lifecycle" && event.phase === "agent_start") started.resolve();
			});
			const work = assembly.corePorts.turnControl.prompt({ text: "wait" });
			await started.promise; unsubscribe();
			await assembly.corePorts.turnControl.abort();
			assert.equal((await work)?.status, "cancelled");
			assert.equal((await assembly.corePorts.turnControl.prompt({ text: "follow up" }))?.status, "completed");
			await assembly.historyController.setName("Codex test session");
			const before = assembly.historyReader.readHistory();
			const path = assembly.lifecycle.sessionPath;
			assert.ok(path);
			const pid = Number(await readFile(join(f.config.profile.codexHome, "host-fixture-pid"), "utf8"));
			await assembly.lifecycle.dispose();
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			assert.equal(f.ownership.held.size, 0);
			const resumed = await f.backend.createAssembly({ ...f.request, sessionPath: path });
			assert.deepEqual(resumed.historyReader.readHistory(), before);
			assert.equal((await f.backend.catalog.listSessions(f.cwd))[0].name, "Codex test session");
			assert.equal((await resumed.corePorts.turnControl.prompt({ text: "after reopen" }))?.status, "completed");
		} finally { await f.cleanup(); }
	});
	it("a definite rejected start does not fabricate a message or prevent a new prompt", async () => {
		const f = await processFixture();
		try {
			const assembly = await f.backend.createAssembly(f.request);
			assert.equal((await assembly.corePorts.turnControl.prompt({ text: "reject" }))?.status, "failed");
			assert.equal(assembly.corePorts.stateReader.readMessages().length, 0);
			assert.equal((await assembly.corePorts.turnControl.prompt({ text: "accepted" }))?.status, "completed");
		} finally { await f.cleanup(); }
	});
	it("unexpected child exit requires reconciliation and preserves the thread association", async () => {
		const f = await processFixture();
		try {
			const assembly = await f.backend.createAssembly(f.request);
			const result = await assembly.corePorts.turnControl.prompt({ text: "exit" });
			assert.equal(result?.status, "failed"); assert.equal(result?.error?.retryable, false);
			assert.equal(f.backend.readSnapshot(assembly.lifecycle.sessionId).state, "recovery-required");
			await assert.rejects(assembly.corePorts.turnControl.prompt({ text: "must not retry" }), { code: "RECOVERY_REQUIRED" });
			assert.ok(assembly.lifecycle.sessionPath);
			assert.equal((await f.backend.catalog.read(assembly.lifecycle.sessionPath)).threadId, "host-fixture-thread");
		} finally { await f.cleanup(); }
	});
});
