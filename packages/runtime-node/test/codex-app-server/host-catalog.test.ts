import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { hostFixture } from "./host-test-support.js";
const fixtures: Array<Awaited<ReturnType<typeof hostFixture>>> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() { const f = await hostFixture(); fixtures.push(f); return f; }

describe("Codex offline catalog and namespace ownership", () => {
	it("rejects relative paths instead of consulting the host process working directory", async () => {
		const f = await fixture();
		await assert.rejects(f.backend.catalog.read("session.codex-session.json"), { code: "CATALOG_FOREIGN" });
		await assert.rejects(f.backend.createAssembly({ ...f.request, sessionPath: "session.codex-session.json" }), { code: "INPUT" });
	});

	it("rejects runtime identity changes through a metadata-only update", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const path = assembly.lifecycle.sessionPath!;
		const before = await f.backend.catalog.read(path);
		const patch = { name: "allowed name", threadId: "different-thread" };
		await assert.rejects(f.backend.catalog.update(path, patch), { code: "CATALOG_INVALID" });
		assert.deepEqual(await f.backend.catalog.read(path), before);
	});

	it("claims its namespace even if a record is missing or malformed, never Native files", async () => {
		const f = await fixture(); const path = await f.backend.catalog.pathFor("missing");
		assert.equal(await f.backend.catalog.ownsSession(path), true);
		assert.equal(await f.backend.catalog.ownsSession(join(f.root, "native.jsonl")), false);
		await writeFile(path, "{broken");
		assert.equal(await f.backend.catalog.ownsSession(path), true);
		await assert.rejects(f.backend.catalog.read(path));
	});
	it("creates an immutable identity and atomically replaces metadata without keeping temporary files", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const path = assembly.lifecycle.sessionPath!; const original = await f.backend.catalog.read(path);
		await assert.rejects(f.backend.catalog.create(original), { code: "EEXIST" });
		await assembly.historyController.setName("Alias");
		const next = await f.backend.catalog.read(path);
		assert.equal(next.name, "Alias"); assert.equal(next.threadId, original.threadId);
		assert.equal(next.profileFingerprint, original.profileFingerprint);
		assert.equal((await readdir(f.config.catalogRoot)).some((name) => name.endsWith(".tmp")), false);
	});
	it("serializes online metadata updates and refuses offline rename while another owner is live", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const path = assembly.lifecycle.sessionPath!;
		await assert.rejects(f.backend.catalog.renameSession(path, "offline"), /already owned/);
		await Promise.all([assembly.historyController.setName("first"), assembly.historyController.setName("last")]);
		assert.equal((await f.backend.catalog.read(path)).name, "last");
		await assembly.lifecycle.dispose(); await f.backend.catalog.renameSession(path, "offline");
		assert.equal((await f.backend.catalog.listSessions(f.cwd))[0].name, "offline");
	});
	it("does not read index symlinks, oversized files or mismatched record IDs", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		const path = assembly.lifecycle.sessionPath!; const original = await readFile(path, "utf8");
		const link = await f.backend.catalog.pathFor("link"); await symlink(path, link);
		await assert.rejects(f.backend.catalog.read(link), { code: "CATALOG_INVALID" });
		const huge = await f.backend.catalog.pathFor("huge"); await writeFile(huge, "x".repeat(17 * 1024));
		await assert.rejects(f.backend.catalog.read(huge), { code: "CATALOG_INVALID" });
		const copied = await f.backend.catalog.pathFor("copied"); await writeFile(copied, original);
		await assert.rejects(f.backend.catalog.read(copied), { code: "CATALOG_INVALID" });
	});
	it("rejects path traversal, unrecognized schema fields, and silent deletion of Codex history", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		await assert.rejects(f.backend.catalog.pathFor("../escape"), { code: "INPUT" });
		const path = assembly.lifecycle.sessionPath!; const record = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, executable: "/untrusted" }));
		await assert.rejects(f.backend.catalog.read(path), { code: "CATALOG_INVALID" });
		await assert.rejects(f.backend.catalog.deleteSessionArtifacts(path), { code: "UNSUPPORTED" });
	});
	it("lists only the requested canonical workspace without launching Codex", async () => {
		const f = await fixture(); const assembly = await f.backend.createAssembly(f.request);
		await assembly.lifecycle.dispose();
		const other = join(f.root, "other"); await mkdir(other);
		assert.equal((await f.backend.catalog.listSessions(other)).length, 0);
		assert.deepEqual(await f.backend.catalog.listProjects(), [{ cwd: f.cwd, sessionCount: 1 }]);
		assert.equal(f.transports.length, 1);
	});
});
