import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CODEX_BUNDLE, codexBundleTarget, stageCodexRuntime } from "./stage-codex-runtime.mjs";

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
test("refuses a failed executable probe and missing license", () => {
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
	assert.throws(() => stageCodexRuntime(f), /license/);
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
