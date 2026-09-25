import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CODEX_BUNDLE, codexBundleTarget, readPinnedCodexNotices, stageCodexRuntime } from "./stage-codex-runtime.mjs";

const cleanups = [];
afterEach(() => {
	for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(target = "darwin-arm64") {
	const root = mkdtempSync(join(tmpdir(), "codex-stage-test-"));
	cleanups.push(root);
	const definition = codexBundleTarget(target);
	const installRoot = join(root, "install");
	const stageRoot = join(root, "stage");
	const packageRoot = join(installRoot, "node_modules", "@openai", "codex");
	const vendor = join(packageRoot, "vendor", definition.triple);
	mkdirSync(join(vendor, "bin"), { recursive: true });
	mkdirSync(stageRoot);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "@openai/codex", version: CODEX_BUNDLE.version }),
	);
	writeFileSync(join(packageRoot, "LICENSE"), "Synthetic test license");
	writeFileSync(join(vendor, "bin", definition.binary), "synthetic binary");
	writeFileSync(join(vendor, "bin", "sandbox-helper"), "synthetic companion");
	writeFileSync(
		join(stageRoot, "electron-builder.json"),
		JSON.stringify({
			appId: "existing",
			extraResources: [{ from: "vendor", to: "vendor" }],
			directories: { output: "release" },
		}),
	);
	return {
		root,
		installRoot,
		stageRoot,
		packageRoot,
		vendor,
		target,
		probe: (binary) => assert.ok(binary.endsWith(definition.binary)),
	};
}
test("stages the whole distribution and adds only its resource without changing application identity", () => {
	const f = fixture();
	const before = JSON.parse(readFileSync(join(f.stageRoot, "electron-builder.json")));
	const executable = stageCodexRuntime(f);
	assert.equal(readFileSync(executable, "utf8"), "synthetic binary");
	assert.equal(
		readFileSync(
			join(f.stageRoot, "codex-runtime", codexBundleTarget(f.target).triple, "bin", "sandbox-helper"),
			"utf8",
		),
		"synthetic companion",
	);
	assert.deepEqual(JSON.parse(readFileSync(join(f.stageRoot, "codex-runtime", "manifest.json"))), {
		schemaVersion: 1,
		version: "0.157.0",
		target: f.target,
	});
	const after = JSON.parse(readFileSync(join(f.stageRoot, "electron-builder.json")));
	assert.deepEqual(after, {
		...before,
		extraResources: [...before.extraResources, { from: "codex-runtime", to: "codex-runtime", filter: ["**/*"] }],
	});
});
test("Windows selection preserves its native executable name", () => {
	const f = fixture("win32-x64");
	assert.ok(stageCodexRuntime(f).endsWith("codex.exe"));
});
test("refuses a different package version before modifying the existing builder configuration", () => {
	const f = fixture();
	const path = join(f.stageRoot, "electron-builder.json");
	const before = readFileSync(path, "utf8");
	writeFileSync(join(f.packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "99.0.0" }));
	assert.throws(() => stageCodexRuntime(f), /version mismatch/);
	assert.equal(readFileSync(path, "utf8"), before);
});
test("refuses a failed executable probe and includes pinned notices when npm omits them", () => {
	const f = fixture();
	assert.throws(
		() =>
			stageCodexRuntime({
				...f,
				probe: () => {
					throw new Error("probe failed");
				},
			}),
		/probe failed/,
	);
	rmSync(join(f.packageRoot, "LICENSE"));
	stageCodexRuntime(f);
	for (const [name, content] of Object.entries(readPinnedCodexNotices())) {
		assert.equal(readFileSync(join(f.stageRoot, "codex-runtime", name), "utf8"), content);
	}
});
test("does not overwrite an existing runtime bundle", () => {
	const f = fixture();
	stageCodexRuntime(f);
	assert.throws(() => stageCodexRuntime(f), /already exists/);
});
test("refuses unknown or inherited target keys", () => {
	for (const target of ["unknown", "../escape", "constructor", "__proto__"])
		assert.throws(() => codexBundleTarget(target), /Unsupported/);
});
test("does not copy a vendor directory linked outside its temporary installation", () => {
	const f = fixture();
	const outside = join(f.root, "outside");
	mkdirSync(outside);
	rmSync(f.vendor, { recursive: true });
	symlinkSync(outside, f.vendor, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => stageCodexRuntime(f), /outside/);
});

test("preserves the codex-directory distribution and its adjacent tools", () => {
	const f = fixture();
	renameSync(join(f.vendor, "bin"), join(f.vendor, "codex"));
	const executable = stageCodexRuntime(f);
	assert.equal(executable, join(f.stageRoot, "codex-runtime", codexBundleTarget(f.target).triple, "codex", "codex"));
	assert.equal(
		readFileSync(
			join(f.stageRoot, "codex-runtime", codexBundleTarget(f.target).triple, "codex", "sandbox-helper"),
			"utf8",
		),
		"synthetic companion",
	);
});
test("resolves an optional dependency beside the real package behind an isolated-store symlink", () => {
	const f = fixture();
	const store = join(f.installRoot, "node_modules", ".store", "codex", "node_modules", "@openai");
	mkdirSync(store, { recursive: true });
	const canonical = join(store, "codex");
	renameSync(f.packageRoot, canonical);
	symlinkSync(canonical, f.packageRoot, process.platform === "win32" ? "junction" : "dir");
	const dependency = join(store, "codex-darwin-arm64");
	mkdirSync(dependency);
	writeFileSync(
		join(dependency, "package.json"),
		JSON.stringify({ name: "@openai/codex", version: "0.157.0-darwin-arm64" }),
	);
	renameSync(join(canonical, "vendor"), join(dependency, "vendor"));
	assert.equal(readFileSync(stageCodexRuntime(f), "utf8"), "synthetic binary");
});
test("refuses multiple executable layouts rather than picking an unintended binary", () => {
	const f = fixture();
	mkdirSync(join(f.vendor, "codex"));
	writeFileSync(join(f.vendor, "codex", "codex"), "other binary");
	assert.throws(() => stageCodexRuntime(f), /ambiguous/);
});

test("rejects altered release notices or a notice version different from the runtime pin", () => {
	const f = fixture();
	const root = join(f.root, "notices");
	mkdirSync(root);
	const pinned = readPinnedCodexNotices();
	const source = JSON.parse(pinned["SOURCE.json"]);
	writeFileSync(join(root, "source.json"), JSON.stringify(source));
	writeFileSync(join(root, "LICENSE"), "tampered");
	writeFileSync(join(root, "NOTICE"), pinned.NOTICE);
	assert.throws(() => readPinnedCodexNotices(root), /checksum/);
	writeFileSync(join(root, "LICENSE"), pinned.LICENSE.replaceAll("\n", "\r\n"));
	assert.deepEqual(readPinnedCodexNotices(root), pinned);
	writeFileSync(join(root, "source.json"), JSON.stringify({ ...source, version: "other" }));
	assert.throws(() => readPinnedCodexNotices(root), /version/);
});
test("retains npm-supplied notices as well as the upstream release attribution", () => {
	const f = fixture();
	writeFileSync(join(f.packageRoot, "NOTICE"), "Synthetic package attribution");
	stageCodexRuntime(f);
	assert.equal(
		readFileSync(join(f.stageRoot, "codex-runtime", "npm-NOTICE"), "utf8"),
		"Synthetic package attribution",
	);
	assert.equal(readFileSync(join(f.stageRoot, "codex-runtime", "NOTICE"), "utf8"), readPinnedCodexNotices().NOTICE);
});
