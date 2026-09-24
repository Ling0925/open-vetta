import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntimeHostBackend } from "../../src/codex-app-server/host-backend.js";
import { deferred } from "../../src/codex-app-server/protocol.js";
import type { CodexHostEvent } from "../../src/codex-app-server/host-contracts.js";
import type { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import { hostFixture } from "./host-test-support.js";
const fixtures: Array<Awaited<ReturnType<typeof hostFixture>>> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() { const f = await hostFixture(); fixtures.push(f); return f; }

describe("Codex RuntimeHost backend contracts", () => {
	it("deduplicates a Codex thread even when two catalogs contain the same association", async () => {
		const f = await hostFixture();
		const second = new CodexRuntimeHostBackend({ ...f.config, catalogRoot: join(f.root, "other-index") });
		try {
			const first = await f.backend.createAssembly(f.request); assert.ok(first.lifecycle.sessionPath);
			const record = await f.backend.catalog.read(first.lifecycle.sessionPath);
			const copyPath = await second.catalog.create(record);
			await assert.rejects(second.createAssembly({ ...f.request, sessionPath: copyPath }), /already owned/);
			assert.equal(f.transports.length, 1);
			await first.lifecycle.dispose();
			await second.createAssembly({ ...f.request, sessionPath: copyPath });
			assert.equal(f.transports.length, 2);
		} finally { await second.dispose(); await f.cleanup(); }
	});

	it("refuses a workspace containing the Codex home or catalog before launching", async () => {
		const f = await hostFixture();
		try {
			await assert.rejects(f.backend.createAssembly({ ...f.request, cwd: f.root }), { code: "CONFIGURATION" });
			assert.equal(f.transports.length, 0); assert.equal(f.ownership.held.size, 0);
		} finally { await f.cleanup(); }
	});

	it("creates → streams → stops → follows up → renames → closes → resumes without copying a transcript", async () => {
		const f = await fixture();
		const assembly = await f.backend.createAssembly(f.request);
		const id = assembly.lifecycle.sessionId;
		const path = assembly.lifecycle.sessionPath!;
		const events: CodexHostEvent[] = [];
		assembly.corePorts.eventStream.subscribe((event) => events.push(event as CodexHostEvent));
		const task = assembly.corePorts.turnControl.prompt({ text: "first" });
		const transport = f.transports[0];
		await transport.waitFor("turn/start");
		assert.equal(assembly.corePorts.stateReader.readState().isStreaming, true);
		const stopped = assembly.corePorts.turnControl.abort();
		await transport.waitFor("turn/interrupt");
		assert.equal(assembly.corePorts.stateReader.readState().isStreaming, true);
		transport.finish("interrupted", "stopped response");
		await stopped;
		assert.equal((await task)?.status, "cancelled");
		const next = assembly.corePorts.turnControl.prompt({ text: "follow up" });
		await Promise.resolve(); await Promise.resolve();
		transport.finish("completed", "complete response");
		assert.equal((await next)?.status, "completed");
		assert.equal(assembly.corePorts.stateReader.readState().isStreaming, false);
		const history = assembly.historyReader.readHistory();
		assert.equal(history.filter((entry) => entry.type === "message").length, 4);
		assert.ok(events.some((event) => event.type === "message.delta" && event.codex.itemId));
		assert.equal(events.filter((event) => event.type === "session.lifecycle" && event.phase === "agent_end").length, 2);
		await assembly.historyController.setName("Local alias");
		const index = JSON.parse(await readFile(path, "utf8"));
		assert.equal(index.name, "Local alias");
		assert.equal(index.runtime, "codex-app-server");
		assert.equal(index.messages, undefined);
		assert.equal(index.turns, undefined);
		assert.equal(index.executable, undefined);
		await assembly.lifecycle.dispose();
		assert.equal(f.ownership.held.size, 0);
		const resumed = await f.backend.createAssembly({ ...f.request, sessionPath: path });
		assert.equal(resumed.lifecycle.sessionId, id);
		assert.deepEqual(resumed.historyReader.readHistory(), history);
		const listed = await f.backend.catalog.listSessions(f.cwd);
		assert.equal(listed[0].name, "Local alias");
		assert.equal(listed[0].firstMessage, "first");
	});

	it("retains ownership while active and rejects duplicate opens from another backend", async () => {
		const f = await fixture();
		const assembly = await f.backend.createAssembly({ ...f.request, sessionId: "fixed" });
		const other = new CodexRuntimeHostBackend(f.config);
		await assert.rejects(other.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath }), /already owned/);
		assert.equal(f.transports.length, 1);
		await assembly.lifecycle.dispose();
		const resumed = await other.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath });
		assert.equal(resumed.lifecycle.sessionId, "fixed");
		await other.dispose();
	});

	it("rejects existing IDs, foreign paths and mismatched identities before starting a process", async () => {
		const f = await fixture();
		const assembly = await f.backend.createAssembly({ ...f.request, sessionId: "fixed" });
		await assembly.lifecycle.dispose();
		await assert.rejects(f.backend.createAssembly({ ...f.request, sessionId: "fixed" }), { code: "SESSION_EXISTS" });
		await assert.rejects(f.backend.createAssembly({ ...f.request, sessionPath: join(f.root, "native.jsonl") }), { code: "CATALOG_FOREIGN" });
		await assert.rejects(f.backend.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath, sessionId: "other" }), { code: "IDENTITY_MISMATCH" });
		assert.equal(f.transports.length, 1);
		assert.equal(f.ownership.held.size, 0);
	});

	it("does not resume under a changed home, version, model, or permission profile", async () => {
		const f = await fixture();
		const assembly = await f.backend.createAssembly(f.request);
		await assembly.lifecycle.dispose();
		const otherHome = join(f.root, "other-home"); await mkdir(otherHome);
		for (const patch of [{ codexHome: otherHome }, { expectedVersion: "1.2.3" }, { model: "other" }, { sandbox: "workspace-write" as const }]) {
			const backend = new CodexRuntimeHostBackend({ ...f.config, profile: { ...f.config.profile, ...patch } });
			await assert.rejects(backend.createAssembly({ ...f.request, sessionPath: assembly.lifecycle.sessionPath }), { code: "PROFILE_MISMATCH" });
			await backend.dispose();
		}
		assert.equal(f.transports.length, 1);
	});

	it("rejects a different working directory when restoring the same conversation", async () => {
		const f = await fixture();
		const assembly = await f.backend.createAssembly(f.request); await assembly.lifecycle.dispose();
		await assert.rejects(f.backend.createAssembly({ ...f.request, cwd: f.root, sessionPath: assembly.lifecycle.sessionPath }), { code: "WORKSPACE_MISMATCH" });
		assert.equal(f.transports.length, 1);
	});

	it("fails unsupported Native operations explicitly and never launches an extra request", async () => {
		const f = await fixture();
		await assert.rejects(f.backend.createAssembly({ ...f.request, executionMode: "full-access" }), { code: "UNSUPPORTED" });
		const assembly = await f.backend.createAssembly(f.request);
		const turns = assembly.corePorts.turnControl;
		await assert.rejects(turns.prompt({ text: "work", images: [{ type: "image", data: "synthetic", mimeType: "image/png" }] }), { code: "UNSUPPORTED" });
		await assert.rejects(turns.prompt({ text: "work", context: [{ type: "restriction", content: "read only", modelVisible: true }] }), { code: "UNSUPPORTED" });
		await assert.rejects(turns.retry(), { code: "UNSUPPORTED" });
		await assert.rejects(turns.continue(), { code: "UNSUPPORTED" });
		await assert.rejects(assembly.historyController.deleteMessage("id"), { code: "UNSUPPORTED" });
		await assert.rejects(assembly.modelController.refreshAuth("synthetic"), { code: "UNSUPPORTED" });
		assert.throws(() => assembly.configurationController.setFollowUpMode("all"), { code: "UNSUPPORTED" });
		assert.equal(f.transports[0].sent.some((frame) => frame.method === "turn/start"), false);
		assert.equal(assembly.codexCapabilities.automaticRetry, false);
	});

	it("rejects concurrent ordinary prompts but accepts steering only for the active turn", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const turns = assembly.corePorts.turnControl;
		const task = turns.prompt({ text: "first" });
		await f.transports[0].waitFor("turn/start"); await Promise.resolve(); await Promise.resolve();
		await assert.rejects(turns.prompt({ text: "duplicate" }), { code: "BUSY" });
		assert.equal((await turns.prompt({ text: "adjust", streamingBehavior: "steer" }))?.status, "handled");
		f.transports[0].finish(); await task;
		assert.equal(f.transports[0].sent.filter((frame) => frame.method === "turn/start").length, 1);
	});

	it("an explicit stop also rejects waiting prompts rather than silently starting them afterwards", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const turns = assembly.corePorts.turnControl;
		const task = turns.prompt({ text: "active" });
		await f.transports[0].waitFor("turn/start");
		const waiting = assert.rejects(turns.promptWhenAvailable({ text: "waiting" }), { code: "CANCELLED" });
		const stop = turns.abort(); await f.transports[0].waitFor("turn/interrupt");
		f.transports[0].finish("interrupted");
		await Promise.all([task, stop, waiting]);
		assert.equal(f.transports[0].sent.filter((frame) => frame.method === "turn/start").length, 1);
	});

	it("waiting-request abort affects only that request, not the active turn", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const task = assembly.corePorts.turnControl.prompt({ text: "active" });
		const controller = new AbortController();
		const waiting = assert.rejects(assembly.corePorts.turnControl.promptWhenAvailable({ text: "wait" }, controller.signal), /cancel wait/);
		controller.abort(new Error("cancel wait")); await waiting;
		assert.equal(f.transports[0].sent.some((frame) => frame.method === "turn/interrupt"), false);
		f.transports[0].finish(); await task;
	});

	it("connection failure returns non-retryable failure and never reports successful cancellation", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const task = assembly.corePorts.turnControl.prompt({ text: "active" });
		await f.transports[0].waitFor("turn/start");
		const stop = assert.rejects(assembly.corePorts.turnControl.abort());
		f.transports[0].failure();
		const outcome = await task; await stop;
		assert.equal(outcome?.status, "failed"); assert.equal(outcome?.error?.retryable, false);
		assert.equal(f.backend.readSnapshot(assembly.lifecycle.sessionId).state, "recovery-required");
		await assert.rejects(assembly.corePorts.turnControl.prompt({ text: "retry" }), { code: "RECOVERY_REQUIRED" });
	});

	it("closing during initialization rolls back both process and leases", async () => {
		const f = await fixture(); const gate = deferred<void>(); const started = deferred<CodexAppServerSession>();
		const backend = new CodexRuntimeHostBackend({ ...f.config, connect: async (options) => {
			const remote = await f.config.connect(options); started.resolve(remote); await gate.promise; return remote;
		} });
		const creation = assert.rejects(backend.createAssembly(f.request), { code: "CLOSED" });
		await started.promise;
		const closing = backend.dispose(); gate.resolve(); await Promise.all([creation, closing]);
		assert.equal(f.transports[0].closed, true); assert.equal(f.ownership.held.size, 0);
	});
});
