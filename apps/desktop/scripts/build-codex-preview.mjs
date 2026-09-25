import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenSourceBuildEnvironment } from "./desktop-build-environment.mjs";
import { resolvePackagedE2eBinaryPath } from "./packaged-e2e-binary.mjs";
import { CODEX_BUNDLE, codexBundleTarget, stageCodexRuntime, verifyPackagedCodex } from "./stage-codex-runtime.mjs";

// Test artifacts only: no tag, publishing, installation or modification of the developer's global Codex.
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const target = `${process.platform}-${process.arch}`;
codexBundleTarget(target);
if (process.argv.length !== 2) throw new Error("This native-host preview build accepts no additional arguments");
const environment = createOpenSourceBuildEnvironment({
	...process.env,
	VETTA_UPDATE_GITHUB_OWNER: "Ling0925",
	VETTA_UPDATE_GITHUB_REPO: "open-vetta",
	VETTA_VENDOR_PLATFORM: target,
	VETTA_CLI_TARGET_PLATFORMS: target,
	VETTA_IM_GATEWAY_TARGET_PLATFORMS: target,
	VETTA_SPEECH_INPUT_ENABLED: "false",
});
// No telemetry projects or signing credentials are needed for a locally tested, unsigned artifact.
for (const key of Object.keys(environment))
	if (/^(VETTA_SENTRY_|VETTA_POSTHOG_|CSC_|APPLE_)/.test(key)) delete environment[key];
environment.VETTA_REQUIRE_MAC_SIGNATURE = "0";
environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const bun = process.platform === "win32" ? "bun.exe" : "bun";
const staging = join(tmpdir(), "vetta-desktop-build");
const releaseRoot = join(desktopRoot, "release");
if (existsSync(releaseRoot) && readdirSync(releaseRoot).length)
	throw new Error("Use a clean build checkout or archive the previous release directory first");
const temporary = mkdtempSync(join(tmpdir(), "vetta-codex-distribution-"));
try {
	writeFileSync(join(temporary, "package.json"), '{"private":true}\n');
	execFileSync(bun, ["add", "--cwd", temporary, "--exact", `@openai/codex@${CODEX_BUNDLE.version}`], {
		env: environment,
		stdio: "inherit",
	});
	execFileSync(bun, ["run", "prepare:desktop-pack"], { cwd: desktopRoot, env: environment, stdio: "inherit" });
	stageCodexRuntime({ installRoot: temporary, stageRoot: staging, target });
	const platform = process.platform === "darwin" ? "mac" : "win";
	execFileSync(
		process.execPath,
		[
			"scripts/run-electron-builder.js",
			"--platform",
			platform,
			"--arch",
			process.arch,
			"--target",
			platform === "mac" ? "dmg,zip" : "zip",
			"--publish",
			"never",
		],
		{ cwd: desktopRoot, env: environment, stdio: "inherit" },
	);
	const packagedExecutable = resolvePackagedE2eBinaryPath(desktopRoot);
	const resources =
		process.platform === "darwin"
			? join(dirname(dirname(packagedExecutable)), "Resources")
			: join(dirname(packagedExecutable), "resources");
	verifyPackagedCodex(resources, target);
	const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;
	const release = join(desktopRoot, "release");
	if (!existsSync(release)) throw new Error("Preview build did not create a release directory");
	writeFileSync(
		join(release, "CODEX-PREVIEW.txt"),
		`${[
			`Vetta ${version} / Codex ${CODEX_BUNDLE.version} / ${target}`,
			`Source: ${process.env.GITHUB_SHA ?? "local working tree"}`,
			"Unsigned, unpublished test artifact. Native stays the default. No automatic installation.",
			"Close the existing Vetta app and back up its data before replacing it. App settings and credential vault are shared.",
			"Only Codex history uses a separate directory. Test in a disposable project and start with read-only permissions.",
			"Open New session > Codex preview, choose an existing Responses model and workspace, save, then create a session.",
			"No ChatGPT login or second gateway key is required. Speech input is excluded from this test build.",
			"This build workflow is not the stable release pipeline. Verify the tests and source commit before use.",
			"Guide: docs/runtime/codex-install-testing.md",
		].join("\n")}\n`,
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
