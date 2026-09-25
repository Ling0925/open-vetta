import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { managedCodexHome, prepareManagedCodexHome, readBundledCodexDefaults } from "./bundled-runtime.js";
import { CodexWorkspaceController } from "./controller.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "vetta-bundled-codex-"));
	roots.push(root);
	const resources = join(root, "Resources");
	const runtimeRoot = join(root, "app-data", "codex-runtime");
	const bundle = join(resources, "codex-runtime");
	const executable = join(bundle, "aarch64-apple-darwin", "bin", "codex");
	await mkdir(join(bundle, "aarch64-apple-darwin", "bin"), { recursive: true });
	await writeFile(executable, "not an executable test fixture");
	await chmod(executable, 0o755);
	const manifest = { schemaVersion: 1, version: "0.157.0", target: "darwin-arm64" };
	const manifestPath = join(bundle, "manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest));
	return {
		root,
		resources,
		runtimeRoot,
		executable,
		manifest,
		manifestPath,
		read: () => readBundledCodexDefaults(resources, runtimeRoot, "darwin", "arm64"),
	};
}
describe("installed Codex first-use configuration", () => {
	it("suggests a bundled executable and independent history without creating files or running it", async () => {
		const f = await fixture();
		assert.deepEqual(await f.read(), {
			executable: f.executable,
			expectedVersion: "0.157.0",
			codexHome: managedCodexHome(f.runtimeRoot),
		});
		await assert.rejects(access(f.runtimeRoot), { code: "ENOENT" });
	});
	it("keeps non-bundled builds compatible and rejects a corrupt or mismatched installed bundle", async () => {
		const f = await fixture();
		for (const text of [
			"{broken",
			JSON.stringify({ ...f.manifest, version: "latest" }),
			JSON.stringify({ ...f.manifest, target: "win32-x64" }),
			"x".repeat(4097),
		]) {
			await writeFile(f.manifestPath, text);
			await assert.rejects(f.read(), { code: "CODEX_BUNDLE_INVALID" });
		}
		await rm(f.manifestPath);
		assert.equal(await f.read(), undefined);
	});
	it("never selects a manifest-supplied executable path", async () => {
		const f = await fixture();
		await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, executable: "/untrusted/program" }));
		assert.equal((await f.read())?.executable, f.executable);
		await rm(f.executable);
		await assert.rejects(f.read(), { code: "CODEX_BUNDLE_INVALID" });
	});
	it("creates only the managed history directory and refuses a symlink in its place", async () => {
		const f = await fixture();
		const manual = join(f.root, "manual");
		await prepareManagedCodexHome(manual, f.runtimeRoot);
		await assert.rejects(access(manual), { code: "ENOENT" });
		await prepareManagedCodexHome(managedCodexHome(f.runtimeRoot), f.runtimeRoot);
		await writeFile(join(managedCodexHome(f.runtimeRoot), "history"), "preserved");
		await prepareManagedCodexHome(managedCodexHome(f.runtimeRoot), f.runtimeRoot);
		assert.equal(await readFile(join(managedCodexHome(f.runtimeRoot), "history"), "utf8"), "preserved");
		await rm(managedCodexHome(f.runtimeRoot), { recursive: true });
		await symlink(f.root, managedCodexHome(f.runtimeRoot), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(prepareManagedCodexHome(managedCodexHome(f.runtimeRoot), f.runtimeRoot), {
			code: "CODEX_HOME_INVALID",
		});
	});
	it("visits setup → confirms configuration → explicitly opens without treating defaults as saved consent", async () => {
		const f = await fixture();
		let writes = 0;
		let opens = 0;
		let confirmed = false;
		const controller = new CodexWorkspaceController({
			readProfile: async () => undefined,
			readRuntimeDefaults: f.read,
			listModels: async () => [{ modelKey: "gateway/model", label: "Gateway", isDefault: true }],
			confirmProfile: async () => {
				confirmed = true;
				return true;
			},
			choosePath: async () => undefined,
			writeProfile: async (profile) => {
				assert.equal(confirmed, true);
				await prepareManagedCodexHome(profile.codexHome, f.runtimeRoot);
				writes++;
			},
			createBackend: () => ({
				list: async () => [],
				close: async () => {},
				open: async () => {
					opens++;
					return {
						id: "test",
						snapshot: () => ({ rows: [], hasEarlierRows: false, recovery: false }),
						subscribe: () => () => {},
						prompt: async () => ({ status: "completed" }),
						stop: async () => {},
						close: async () => {},
					};
				},
			}),
		});
		try {
			const view = await controller.attach();
			assert.equal(view.snapshot.profile, undefined);
			assert.equal(view.snapshot.phase, "setup");
			assert.equal(writes, 0);
			assert.equal(opens, 0);
			assert.ok(view.snapshot.runtimeDefaults);
			await assert.rejects(access(f.runtimeRoot), { code: "ENOENT" });
			assert.deepEqual(await controller.execute(view.token, { type: "open" }), { ok: false, code: "CONFIGURATION" });
			const profile = {
				...view.snapshot.runtimeDefaults,
				cwd: f.root,
				sandbox: "read-only",
				vettaModelKey: "gateway/model",
			};
			assert.equal((await controller.execute(view.token, { type: "configure", profile })).ok, true);
			assert.equal(writes, 1);
			assert.equal(opens, 0);
			assert.equal((await controller.execute(view.token, { type: "open" })).ok, true);
			assert.equal(opens, 1);
		} finally {
			await controller.dispose();
		}
	});
	it("does not overwrite an existing manually confirmed profile with bundle defaults", async () => {
		const f = await fixture();
		const profile = {
			executable: join(f.root, "custom"),
			expectedVersion: "1.0.0",
			codexHome: join(f.root, "old"),
			cwd: f.root,
			sandbox: "read-only" as const,
		};
		const controller = new CodexWorkspaceController({
			readProfile: async () => profile,
			readRuntimeDefaults: f.read,
			writeProfile: async () => {
				throw new Error("must not write");
			},
			confirmProfile: async () => false,
			choosePath: async () => undefined,
			createBackend: () => ({
				list: async () => [],
				open: async () => {
					throw new Error("must not launch");
				},
				close: async () => {},
			}),
		});
		try {
			const view = await controller.attach();
			assert.deepEqual(view.snapshot.profile, profile);
			assert.equal(view.snapshot.runtimeDefaults?.executable, f.executable);
		} finally {
			await controller.dispose();
		}
	});
});

describe("packaged native distribution layouts", () => {
	it("finds the supported codex directory without moving adjacent resources", async () => {
		const f = await fixture();
		const triple = join(f.resources, "codex-runtime", "aarch64-apple-darwin");
		await rename(join(triple, "bin"), join(triple, "codex"));
		assert.equal((await f.read())?.executable, join(triple, "codex", "codex"));
	});
	it("rejects two possible installed executables", async () => {
		const f = await fixture();
		const other = join(f.resources, "codex-runtime", "aarch64-apple-darwin", "codex");
		await mkdir(other);
		await writeFile(join(other, "codex"), "synthetic ambiguity");
		await assert.rejects(f.read(), { code: "CODEX_BUNDLE_INVALID" });
	});
});
