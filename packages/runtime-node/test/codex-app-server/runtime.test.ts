import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { openCodexAppServerSession } from "../../src/codex-app-server/index.js";
import { CodexStdioTransport } from "../../src/codex-app-server/stdio.js";
import type { CodexAppServerSession } from "../../src/codex-app-server/session.js";
import type { CodexSessionEvent, OpenCodexSessionOptions } from "../../src/codex-app-server/types.js";
const directories: string[] = [];
const sessions: CodexAppServerSession[] = [];
const fixture = fileURLToPath(new URL("./fixture-app-server.mjs", import.meta.url));
async function options(mode = "normal"): Promise<OpenCodexSessionOptions> {
	const directory = await mkdtemp(join(tmpdir(), "vetta-codex-test-"));
	directories.push(directory);
	const cwd = join(directory, "workspace");
	const codexHome = join(directory, "codex-home");
	await Promise.all([mkdir(cwd), mkdir(codexHome)]);
	return { executable: process.execPath, executableArgs: [fixture, mode], cwd, codexHome,
		expectedVersion: "0.0.0-test", requestTimeoutMs: 2000, interruptTimeoutMs: 1000 };
}
async function open(config: OpenCodexSessionOptions): Promise<CodexAppServerSession> {
	const session = await openCodexAppServerSession(config);
	sessions.push(session);
	return session;
}
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("public Codex adapter over real child-process stdio", () => {
	it("creates → streams → stops → follows up → closes → resumes the same persisted thread", async () => {
		const config = await options();
		const session = await open(config);
		const events: CodexSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		const first = await session.startTurn({ text: "hello", inputId: "first-input" });
		assert.equal((await first.completed).status, "completed");
		assert.ok(events.some((event) => event.method === "item/agentMessage/delta" && event.params.delta === "你好"));
		const waiting = await session.startTurn({ text: "wait" });
		await session.steer({ text: "adjust", expectedTurnId: waiting.turnId });
		await session.interrupt(waiting.turnId);
		assert.equal((await waiting.completed).status, "interrupted");
		const last = await session.startTurn({ text: "follow up" });
		await last.completed;
		assert.equal((await session.refreshHistory()).turns.length, 3);
		const id = session.threadId;
		await session.close();
		const resumed = await open({ ...config, threadId: id });
		assert.equal(resumed.threadId, id);
		assert.equal(resumed.readThread().turns.length, 3);
		const next = await resumed.startTurn({ text: "resume follow up" });
		assert.equal((await next.completed).status, "completed");
		assert.equal(resumed.readThread().turns.length, 4);
	});
	it("declines server approvals when no UI is installed", async () => {
		const session = await open(await options());
		const run = await session.startTurn({ text: "approve" });
		assert.equal((await run.completed).items[0].text, JSON.stringify({ decision: "decline" }));
	});
	it("requires an explicit handler for write mode and supports per-request approval", async () => {
		const config = { ...await options(), sandbox: "workspace-write" as const };
		await assert.rejects(openCodexAppServerSession(config), /explicit host approval handler/);
		const session = await open({ ...config, onApproval: async (request) => {
				assert.equal(request.method, "item/commandExecution/requestApproval");
				return "accept";
			} });
		const run = await session.startTurn({ text: "approve" });
		assert.equal((await run.completed).items[0].text, JSON.stringify({ decision: "accept" }));
	});
	for (const mode of ["bad-policy", "network", "auto-review", "outside-root"]) {
		it(`fails closed before sending a turn when effective policy is ${mode}`, async () => {
			const config = await options(mode);
			await assert.rejects(openCodexAppServerSession({ ...config,
				...(mode === "outside-root" ? { sandbox: "workspace-write", onApproval: async () => "decline" as const } : {}),
			}), (error: unknown) => error instanceof Error && "code" in error && error.code === "POLICY_MISMATCH");
			await assert.rejects(readFile(join(config.codexHome!, "fixture-history.json")), { code: "ENOENT" });
		});
	}
	it("rejects an unverified binary version before starting app-server", async () => {
		const config = await options();
		await assert.rejects(openCodexAppServerSession({ ...config, expectedVersion: "1.2.3" }), /host-verified version/);
		await assert.rejects(readFile(join(config.codexHome!, "fixture-pid")), { code: "ENOENT" });
	});
	for (const mode of ["invalid-json", "invalid-utf8", "oversize", "eof"]) {
		it(`settles initialization and cleans up on ${mode}`, async () => {
			const config = await options(mode);
			await assert.rejects(openCodexAppServerSession({ ...config, maxFrameBytes: 1024 }));
			const pid = Number(await readFile(join(config.codexHome!, "fixture-pid"), "utf8"));
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		});
	}
	it("does not forward unrelated provider credentials to the subprocess", async () => {
		const old = process.env.VETTA_TEST_PRIVATE_TOKEN;
		const provider = process.env.OPENAI_API_KEY;
		process.env.VETTA_TEST_PRIVATE_TOKEN = "synthetic-test-value";
		process.env.OPENAI_API_KEY = "synthetic-test-value";
		try {
			const config = await options();
			const session = await open(config);
			const run = await session.startTurn({ text: "environment" });
			const result = await run.completed;
			assert.deepEqual(JSON.parse(String(result.items[0].text)), {
				tokenForwarded: false, providerKeyForwarded: false, home: config.codexHome,
			});
		}
		finally {
			if (old === undefined)
				delete process.env.VETTA_TEST_PRIVATE_TOKEN;
			else
				process.env.VETTA_TEST_PRIVATE_TOKEN = old;
			if (provider === undefined)
				delete process.env.OPENAI_API_KEY;
			else
				process.env.OPENAI_API_KEY = provider;
		}
	});
	it("forces an owned process to exit after its stdin shutdown grace expires", async () => {
		const config = await options("hung-close");
		const session = await open({ ...config, shutdownTimeoutMs: 100 });
		const pid = Number(await readFile(join(config.codexHome!, "fixture-pid"), "utf8"));
		const closing = session.close();
		assert.equal(session.close(), closing);
		await closing;
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
	it("rejects relative executable and cwd paths rather than resolving workspace-controlled commands", async () => {
		const config = await options();
		await assert.rejects(CodexStdioTransport.launch({ ...config, executable: "codex" }), /absolute paths/);
		await assert.rejects(CodexStdioTransport.launch({ ...config, cwd: "." }), /absolute paths/);
	});
});
