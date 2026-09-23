import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
	buildCommand,
	candidateUnpackedAppPaths,
	classifySigningTarget,
	createSigningOptions,
	createLocalBuildEnvironment,
	parseAppProcesses,
	replaceInstalledApp,
	resolveEntitlementsForPath,
	resolveUnpackedApp,
	runPackageAndInstall,
} from "./package-and-install-mac.mjs";

const temporaryRoots = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fs = { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile };

async function createApp(root, name, marker) {
	const app = join(root, name, "Vetta.app");
	await mkdir(join(app, "Contents"), { recursive: true });
	await writeFile(join(app, "Contents", "marker"), marker);
	return app;
}

function createProcessFixture({ commands, phase = "old-running", startup = true, refuseQuit = false } = {}) {
	let currentPhase = phase;
	const processCalls = [];
	const runCommand = async (command, args) => {
		commands.push({ command, args: [...args] });
		if (command === "osascript" && !refuseQuit) currentPhase = "old-stopped";
		if (command === "open") currentPhase = startup ? "new-running" : "candidate-failed";
		return { status: 0 };
	};
	const listProcesses = async () => {
		processCalls.push(currentPhase);
		if (currentPhase === "old-running") return [101];
		if (currentPhase === "new-running") return [202];
		if (currentPhase === "old-reopened") return [101];
		return [];
	};
	return { runCommand, listProcesses, processCalls, setPhase: (next) => (currentPhase = next) };
}

function stableTimings() {
	return { quitTimeoutMs: 0, startTimeoutMs: 0, pollIntervalMs: 1, startStabilityMs: 0 };
}

test("build command keeps the existing open-source graph and only adds dir for app-only", () => {
	assert.deepEqual(buildCommand({ arch: "arm64" }), {
		command: "bun",
		args: ["run", "dist:opensource", "--", "--platform", "mac", "--arch", "arm64"],
	});
	assert.deepEqual(buildCommand({ arch: "x64", appOnly: true }), {
		command: "bun",
		args: ["run", "dist:opensource", "--", "--platform", "mac", "--arch", "x64", "--target", "dir"],
	});
});

test("local packaging clears release signing state and pins the current target", () => {
	const source = {
		PATH: "/usr/bin",
		APPLE_ID: "developer@example.com",
		CSC_LINK: "secret-certificate",
		CSC_IDENTITY_AUTO_DISCOVERY: "true",
		VETTA_REQUIRE_MAC_SIGNATURE: "1",
		VETTA_SKIP_NOTARIZE: "1",
		VETTA_VENDOR_PLATFORM: "win32-x64",
	};
	const environment = createLocalBuildEnvironment(source, { arch: "arm64", version: "0.5.59" });
	assert.equal(environment.PATH, "/usr/bin");
	assert.equal(environment.APPLE_ID, undefined);
	assert.equal(environment.CSC_LINK, undefined);
	assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, "false");
	assert.equal(environment.VETTA_SKIP_NOTARIZE, undefined);
	assert.equal(environment.VETTA_REQUIRE_MAC_SIGNATURE, "0");
	assert.equal(environment.VETTA_DESKTOP_BUILD_VERSION, "0.5.59");
	assert.equal(environment.VETTA_VENDOR_PLATFORM, "darwin-arm64");
	assert.equal(environment.VETTA_CLI_TARGET_PLATFORMS, "darwin-arm64");
	assert.equal(environment.VETTA_IM_GATEWAY_TARGET_PLATFORMS, "darwin-arm64");
	assert.equal(source.CSC_LINK, "secret-certificate");
});

test("selects the architecture-specific unpacked app and verifies metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const releaseDir = join(root, "release");
	const armApp = await createApp(releaseDir, "mac-arm64", "arm");
	await createApp(releaseDir, "mac", "generic");
	const inspected = [];
	const readMetadata = async (appPath) => {
		inspected.push(appPath);
		return { bundleIdentifier: "com.vetta.desktop", version: "0.5.59" };
	};
	assert.equal(
		await resolveUnpackedApp({
			releaseDir,
			arch: "arm64",
			expectedVersion: "0.5.59",
			fs,
			readMetadata,
			readArchitectures: async () => ["arm64"],
		}),
		armApp,
	);
	assert.deepEqual(candidateUnpackedAppPaths(releaseDir, "x64"), [
		join(releaseDir, "mac", "Vetta.app"),
		join(releaseDir, "mac-x64", "Vetta.app"),
	]);
	assert.equal(inspected.length, 1);
});

test("skips a same-version unpacked app built for the wrong architecture", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const releaseDir = join(root, "release");
	const wrongGenericApp = await createApp(releaseDir, "mac", "wrong-architecture");
	const x64App = await createApp(releaseDir, "mac-x64", "x64");
	const selected = await resolveUnpackedApp({
		releaseDir,
		arch: "x64",
		expectedVersion: "0.5.59",
		fs,
		readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
		readArchitectures: async (appPath) => (appPath === wrongGenericApp ? ["arm64"] : ["x64"]),
	});
	assert.equal(selected, x64App);
});

test("classifies outer app, nested helper apps, and ordinary binaries for entitlements", () => {
	const paths = {
		outer: "/tmp/entitlements.mac.plist",
		inherit: "/tmp/entitlements.mac.inherit.plist",
		empty: "/tmp/empty.plist",
	};
	assert.equal(classifySigningTarget("Vetta.app"), "outer-app");
	assert.equal(classifySigningTarget("Contents/Frameworks/Vetta Helper.app"), "nested-app");
	assert.equal(
		classifySigningTarget("Contents/Frameworks/Vetta Helper.app/Contents/MacOS/Vetta Helper"),
		"nested-app",
	);
	assert.equal(classifySigningTarget("Contents/Resources/vetta-sidecar"), "ordinary");
	assert.equal(resolveEntitlementsForPath("Vetta.app", {
		outerEntitlements: paths.outer,
		inheritedEntitlements: paths.inherit,
		emptyEntitlements: paths.empty,
	}), paths.outer);
	assert.equal(resolveEntitlementsForPath("Contents/Frameworks/Vetta Helper.app", {
		outerEntitlements: paths.outer,
		inheritedEntitlements: paths.inherit,
		emptyEntitlements: paths.empty,
	}), paths.inherit);
	assert.equal(
		resolveEntitlementsForPath("Contents/Frameworks/Vetta Helper.app/Contents/MacOS/Vetta Helper", {
			outerEntitlements: paths.outer,
			inheritedEntitlements: paths.inherit,
			emptyEntitlements: paths.empty,
		}),
		paths.inherit,
	);
	assert.equal(resolveEntitlementsForPath("Contents/Resources/vetta-sidecar", {
		outerEntitlements: paths.outer,
		inheritedEntitlements: paths.inherit,
		emptyEntitlements: paths.empty,
	}), paths.empty);
	const signingOptions = createSigningOptions({
		appPath: "/tmp/Vetta.app",
		outerEntitlements: paths.outer,
		inheritedEntitlements: paths.inherit,
		emptyEntitlements: paths.empty,
	});
	assert.equal(signingOptions.optionsForFile("/tmp/Vetta.app").entitlements, paths.outer);
	assert.equal(signingOptions.optionsForFile("/tmp/Vetta.app/Contents/MacOS/Vetta").entitlements, paths.empty);
	assert.equal(
		signingOptions.optionsForFile("/tmp/Vetta.app/Contents/Frameworks/Vetta Helper.app/Contents/MacOS/Vetta Helper")
			.entitlements,
		paths.inherit,
	);
	assert.equal(
		signingOptions.optionsForFile("/tmp/Vetta.app/Contents/Frameworks/Vetta Helper.app").entitlements,
		paths.inherit,
	);
	assert.equal(signingOptions.optionsForFile("/tmp/Vetta.app/Contents/Resources/vetta-sidecar").entitlements, paths.empty);
});

test("distinguishes the Vetta main process from helpers and unrelated commands", () => {
	const appPath = "/Applications/Vetta.app";
	assert.deepEqual(
		parseAppProcesses(
			[
				"101 /Applications/Vetta.app/Contents/Frameworks/Vetta Helper.app/Contents/MacOS/Vetta Helper --type=utility",
				"202 /Applications/Vetta.app/Contents/MacOS/Vetta",
				"303 node probe.js /Applications/Vetta.app/Contents/MacOS/Vetta",
			].join("\n"),
			appPath,
		),
		[
			{
				pid: 101,
				command:
					"/Applications/Vetta.app/Contents/Frameworks/Vetta Helper.app/Contents/MacOS/Vetta Helper --type=utility",
				isMain: false,
			},
			{ pid: 202, command: "/Applications/Vetta.app/Contents/MacOS/Vetta", isMain: true },
		],
	);
});

test("replaces an installed app atomically after signing and quitting the old app", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(dirname(destination), { recursive: true });
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const commands = [];
	const processFixture = createProcessFixture({ commands });
	const actions = [];
	const signer = async (options) => {
		actions.push({ type: "sign", options });
	};
	const runCommand = async (command, args, options) => {
		if (command === "ditto") throw new Error("ditto is not used by replaceInstalledApp");
		actions.push({ type: command, args: [...args] });
		return processFixture.runCommand(command, args, options);
	};
	const result = await replaceInstalledApp({
		stagedApp,
		destination,
		expectedVersion: "0.5.59",
		packageRoot: root,
		fs: {
			...fs,
			rename: async (...args) => {
				actions.push({ type: "rename", args });
				return (await import("node:fs/promises")).rename(...args);
			},
		},
		runCommand,
		signer,
		readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
		listProcesses: processFixture.listProcesses,
		makeId: () => "test-id",
		timings: stableTimings(),
		sleep: async () => {},
		logger: () => {},
	});
	assert.equal(result.destination, destination);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "new");
	assert.deepEqual((await readdir(dirname(destination))).sort(), ["Vetta.app"]);
	assert.equal(actions.findIndex((action) => action.type === "sign") < actions.findIndex((action) => action.type === "osascript"), true);
	assert.equal(actions.findIndex((action) => action.type === "osascript") < actions.findIndex((action) => action.type === "rename"), true);
	assert.equal(commands.some(({ command, args }) => command === "open" && args[0] === destination), true);
});

test("runs a normal app-only package flow without touching a real install path", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const packageRoot = join(root, "desktop");
	const releaseDir = join(packageRoot, "release");
	const destination = join(root, "Applications", "Vetta.app");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.5.59" }));
	const sourceApp = await createApp(releaseDir, "mac-arm64", "new");
	await mkdir(dirname(destination), { recursive: true });
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const actions = [];
	const processFixture = createProcessFixture({ commands: actions });
	const runCommand = async (command, args, options) => {
		actions.push({ command, args: [...args] });
		if (command === "ditto") await cp(args[0], args[1], { recursive: true });
		return processFixture.runCommand(command, args, options);
	};
	await runPackageAndInstall({
		argv: ["--app-only", "--destination", destination],
		platform: "darwin",
		arch: "arm64",
		packageRoot,
		releaseDir,
		fs,
		runCommand,
		signer: async () => {},
		readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
		readArchitectures: async () => ["arm64"],
		listProcesses: processFixture.listProcesses,
		timings: stableTimings(),
		sleep: async () => {},
		logger: () => {},
	});
	assert.equal(sourceApp.endsWith("mac-arm64/Vetta.app"), true);
	assert.equal(actions.some(({ command, args }) => command === "bun" && args.includes("verify:updates:mac")), false);
	assert.equal(actions.some(({ command, args }) => command === "bun" && args.includes("--target") && args.includes("dir")), true);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "new");
});

test("restores the old app and reopens it when the candidate cannot start", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const commands = [];
	const processFixture = createProcessFixture({ commands, startup: false });
	await assert.rejects(
		replaceInstalledApp({
			stagedApp,
			destination,
			expectedVersion: "0.5.59",
			packageRoot: root,
			fs,
			runCommand: processFixture.runCommand,
			signer: async () => {},
			readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
			listProcesses: processFixture.listProcesses,
			timings: stableTimings(),
			sleep: async () => {},
			makeId: () => "rollback-id",
			logger: () => {},
		}),
		/Timed out waiting for Vetta\.app to start/,
	);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "old");
	assert.deepEqual((await readdir(dirname(destination))).sort(), ["Vetta.app"]);
	assert.equal(commands.filter(({ command }) => command === "open").length, 2);
});

test("does not move an installation when the current app refuses to exit", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const commands = [];
	const processFixture = createProcessFixture({ commands, refuseQuit: true });
	const kills = [];
	await assert.rejects(
		replaceInstalledApp({
			stagedApp,
			destination,
			expectedVersion: "0.5.59",
			packageRoot: root,
			fs,
			runCommand: processFixture.runCommand,
			signer: async () => {},
			readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
			listProcesses: processFixture.listProcesses,
			killProcess: (pid) => kills.push(pid),
			timings: stableTimings(),
			sleep: async () => {},
			logger: () => {},
		}),
		/existing installation was left untouched/,
	);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "old");
	assert.deepEqual((await readdir(dirname(destination))).sort(), ["Vetta.app"]);
	assert.deepEqual(kills, [101]);
});

test("does not accept a leftover helper as a successful restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	let phase = "old-running";
	let openCount = 0;
	const runCommand = async (command) => {
		if (command === "osascript") phase = "stopped";
		if (command === "open") {
			openCount += 1;
			phase = openCount === 1 ? "helper-running" : "old-running";
		}
		return { status: 0 };
	};
	const listProcesses = async () => {
		if (phase === "old-running") return [{ pid: 101, isMain: true }];
		if (phase === "helper-running") return [{ pid: 202, isMain: false }];
		return [];
	};
	await assert.rejects(
		replaceInstalledApp({
			stagedApp,
			destination,
			expectedVersion: "0.5.59",
			packageRoot: root,
			fs,
			runCommand,
			signer: async () => {},
			readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
			listProcesses,
			timings: stableTimings(),
			sleep: async () => {},
			logger: () => {},
		}),
		/Timed out waiting for Vetta\.app to start/,
	);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "old");
	assert.equal(openCount, 2);
});

test("preserves the previous app backup when rollback restoration fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const backupPath = join(dirname(destination), `.Vetta.backup-${process.pid}-restore-failure.app`);
	const processFixture = createProcessFixture({ commands: [], startup: false });
	const refusingFs = {
		...fs,
		rename: async (source, target) => {
			if (source === backupPath && target === destination) throw new Error("simulated restore failure");
			return rename(source, target);
		},
	};
	await assert.rejects(
		replaceInstalledApp({
			stagedApp,
			destination,
			expectedVersion: "0.5.59",
			packageRoot: root,
			fs: refusingFs,
			runCommand: processFixture.runCommand,
			signer: async () => {},
			readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
			listProcesses: processFixture.listProcesses,
			timings: stableTimings(),
			sleep: async () => {},
			makeId: () => "restore-failure",
			logger: () => {},
		}),
		(error) => {
			assert.equal(error instanceof AggregateError, true);
			assert.match(error.message, /previous installation is preserved/);
			return true;
		},
	);
	assert.equal(await readFile(join(backupPath, "Contents", "marker"), "utf8"), "old");
});

test("keeps the working candidate when old-backup cleanup fails partway", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-local-package-test-"));
	temporaryRoots.push(root);
	const destination = join(root, "Applications", "Vetta.app");
	const stagedApp = await createApp(root, "staging", "new");
	await mkdir(join(destination, "Contents"), { recursive: true });
	await writeFile(join(destination, "Contents", "marker"), "old");
	const backupPath = join(dirname(destination), `.Vetta.backup-${process.pid}-cleanup-failure.app`);
	const processFixture = createProcessFixture({ commands: [] });
	const logs = [];
	const partialCleanupFs = {
		...fs,
		rm: async (target, options) => {
			if (target === backupPath) {
				await rm(join(target, "Contents", "marker"), { force: true });
				throw new Error("simulated partial backup cleanup");
			}
			return rm(target, options);
		},
	};
	const result = await replaceInstalledApp({
		stagedApp,
		destination,
		expectedVersion: "0.5.59",
		packageRoot: root,
		fs: partialCleanupFs,
		runCommand: processFixture.runCommand,
		signer: async () => {},
		readMetadata: async () => ({ bundleIdentifier: "com.vetta.desktop", version: "0.5.59" }),
		listProcesses: processFixture.listProcesses,
		timings: stableTimings(),
		sleep: async () => {},
		makeId: () => "cleanup-failure",
		logger: (message) => logs.push(message),
	});
	assert.equal(result.backupPath, backupPath);
	assert.equal(await readFile(join(destination, "Contents", "marker"), "utf8"), "new");
	assert.equal((await stat(backupPath)).isDirectory(), true);
	assert.equal(logs.some((message) => message.includes("backup could not be fully removed")), true);
});
