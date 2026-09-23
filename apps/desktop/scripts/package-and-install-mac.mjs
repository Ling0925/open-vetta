import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { MAC_SIGNING_ENV_KEYS } from "./mac-signing-config.mjs";

const packageDir = resolve(import.meta.dirname, "..");
const defaultReleaseDir = join(packageDir, "release");
const expectedBundleIdentifier = "com.vetta.desktop";
const supportedArchitectures = new Set(["arm64", "x64"]);
const defaultTimings = Object.freeze({
	quitTimeoutMs: 10_000,
	startTimeoutMs: 15_000,
	pollIntervalMs: 100,
	startStabilityMs: 1_000,
});

const defaultFileSystem = Object.freeze({ access, mkdtemp, readFile, rename, rm, stat, writeFile });

function defaultLogger(message) {
	console.info(`[package-and-install-mac] ${message}`);
}

function defaultRunCommand(command, args, { cwd, env, capture = false } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		let stdout = "";
		let stderr = "";
		if (capture) {
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
		}
		child.once("error", reject);
		child.once("close", (status, signal) => {
			if (status !== 0) {
				const details = stderr.trim() || `exited with ${String(status ?? signal)}`;
				const error = new Error(`${command} ${args.join(" ")} failed: ${details}`);
				error.status = status;
				error.signal = signal;
				reject(error);
				return;
			}
			resolvePromise({ status: 0, stdout, stderr });
		});
	});
}

function defaultSleep(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultKillProcess(pid) {
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

export function parseArguments(argv) {
	const args = [...argv];
	if (args[0] === "--") args.shift();
	const options = { appOnly: false, destination: undefined };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--app-only") {
			options.appOnly = true;
			continue;
		}
		if (arg === "--destination" || arg.startsWith("--destination=")) {
			const value = arg === "--destination" ? args[++index] : arg.slice("--destination=".length);
			if (!value?.trim()) throw new Error("--destination requires a Vetta.app path");
			options.destination = value.trim();
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

export function buildCommand({ arch, appOnly = false } = {}) {
	if (!supportedArchitectures.has(arch)) {
		throw new Error(`Unsupported macOS architecture: ${arch}; expected arm64 or x64`);
	}
	const args = ["run", "dist:opensource", "--", "--platform", "mac", "--arch", arch];
	if (appOnly) args.push("--target", "dir");
	return { command: "bun", args };
}

export function createLocalBuildEnvironment(env, { arch, version } = {}) {
	if (!supportedArchitectures.has(arch)) {
		throw new Error(`Unsupported macOS architecture: ${arch}; expected arm64 or x64`);
	}
	if (typeof version !== "string" || version.length === 0) {
		throw new Error("A Desktop version is required for the local macOS build");
	}
	const buildEnvironment = { ...env };
	for (const key of MAC_SIGNING_ENV_KEYS) delete buildEnvironment[key];
	delete buildEnvironment.VETTA_SKIP_NOTARIZE;
	const platformTag = `darwin-${arch}`;
	return {
		...buildEnvironment,
		CSC_IDENTITY_AUTO_DISCOVERY: "false",
		VETTA_CLI_TARGET_PLATFORMS: platformTag,
		VETTA_DESKTOP_BUILD_VERSION: version,
		VETTA_IM_GATEWAY_TARGET_PLATFORMS: platformTag,
		VETTA_REQUIRE_MAC_SIGNATURE: "0",
		VETTA_VENDOR_PLATFORM: platformTag,
	};
}

async function pathExists(path, fs = defaultFileSystem) {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path, fs = defaultFileSystem) {
	try {
		return (await fs.stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readPlistValue(infoPlistPath, key, { runCommand = defaultRunCommand } = {}) {
	const result = await runCommand(
		"/usr/libexec/PlistBuddy",
		["-c", `Print :${key}`, infoPlistPath],
		{ capture: true },
	);
	return String(result?.stdout ?? "").trim();
}

export async function readBundleMetadata(
	appPath,
	{ readPlist = readPlistValue, runCommand = defaultRunCommand } = {},
) {
	const infoPlistPath = join(appPath, "Contents", "Info.plist");
	const [bundleIdentifier, version] = await Promise.all([
		readPlist(infoPlistPath, "CFBundleIdentifier", { runCommand }),
		readPlist(infoPlistPath, "CFBundleShortVersionString", { runCommand }),
	]);
	return { bundleIdentifier, version };
}

export function assertBundleMetadata(metadata, expectedVersion, appPath = "Vetta.app") {
	if (metadata?.bundleIdentifier !== expectedBundleIdentifier) {
		throw new Error(
			`Bundle identifier mismatch for ${appPath}: expected ${expectedBundleIdentifier}, got ${String(metadata?.bundleIdentifier)}`,
		);
	}
	if (metadata?.version !== expectedVersion) {
		throw new Error(
			`Bundle version mismatch for ${appPath}: expected ${expectedVersion}, got ${String(metadata?.version)}`,
		);
	}
}

async function readAndAssertBundleMetadata(appPath, expectedVersion, dependencies) {
	const metadata = await (dependencies.readMetadata ?? readBundleMetadata)(appPath, dependencies);
	assertBundleMetadata(metadata, expectedVersion, appPath);
	return metadata;
}

function normalizeMachOArchitecture(architecture) {
	return architecture === "x86_64" ? "x64" : architecture;
}

export async function readBundleArchitectures(appPath, { runCommand = defaultRunCommand } = {}) {
	const executablePath = join(appPath, "Contents", "MacOS", "Vetta");
	const result = await runCommand("/usr/bin/lipo", ["-archs", executablePath], { capture: true });
	const architectures = String(result?.stdout ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(normalizeMachOArchitecture);
	if (architectures.length === 0) throw new Error(`Could not read Mach-O architecture from ${executablePath}`);
	return architectures;
}

export function assertBundleArchitecture(architectures, expectedArchitecture, appPath = "Vetta.app") {
	if (!architectures.includes(expectedArchitecture)) {
		throw new Error(
			`Bundle architecture mismatch for ${appPath}: expected ${expectedArchitecture}, got ${architectures.join(", ") || "unknown"}`,
		);
	}
}

export function candidateUnpackedAppPaths(releaseDir, arch) {
	if (!supportedArchitectures.has(arch)) {
		throw new Error(`Unsupported macOS architecture: ${arch}; expected arm64 or x64`);
	}
	const directories = arch === "arm64" ? ["mac-arm64", "mac"] : ["mac", "mac-x64"];
	return directories.map((directory) => join(releaseDir, directory, "Vetta.app"));
}

export async function resolveUnpackedApp({
	releaseDir = defaultReleaseDir,
	arch,
	expectedVersion,
	fs = defaultFileSystem,
	readMetadata,
	readArchitectures = readBundleArchitectures,
	readPlist = readPlistValue,
	runCommand = defaultRunCommand,
} = {}) {
	const candidates = candidateUnpackedAppPaths(releaseDir, arch);
	const errors = [];
	for (const candidate of candidates) {
		if (!(await isDirectory(candidate, fs))) continue;
		try {
			const metadata = await (readMetadata ?? readBundleMetadata)(candidate, { readPlist, runCommand });
			assertBundleMetadata(metadata, expectedVersion, candidate);
			const architectures = await readArchitectures(candidate, { runCommand });
			assertBundleArchitecture(architectures, arch, candidate);
			return candidate;
		} catch (error) {
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const detail = errors.length > 0 ? `\n${errors.join("\n")}` : "";
	throw new Error(`No valid unpacked Vetta.app found for macOS ${arch} in release/.${detail}`);
}

export async function resolveDestination({
	destination,
	home = homedir(),
	fs = defaultFileSystem,
	cwd = process.cwd(),
} = {}) {
	if (destination) {
		const expanded = destination.startsWith("~/") ? join(home, destination.slice(2)) : destination;
		const resolvedDestination = resolve(cwd, expanded);
		if (basename(resolvedDestination) !== "Vetta.app") {
			throw new Error(`--destination must point to a Vetta.app path: ${destination}`);
		}
		return resolvedDestination;
	}
	const systemDestination = "/Applications/Vetta.app";
	if (await isDirectory(systemDestination, fs)) return systemDestination;
	const userDestination = join(home, "Applications", "Vetta.app");
	if (await isDirectory(userDestination, fs)) return userDestination;
	return systemDestination;
}

export async function assertDestinationParentWritable(destination, fs = defaultFileSystem) {
	const parent = dirname(destination);
	try {
		if (!(await isDirectory(parent, fs))) throw new Error("parent is not a directory");
		await fs.access(parent, fsConstants.W_OK);
	} catch (error) {
		throw new Error(
			`Destination parent directory is not writable before packaging: ${parent}. ` +
			`Choose a writable --destination or grant access (details: ${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

export function classifySigningTarget(relativePath) {
	const normalized = relativePath.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
	if (normalized.length === 0 || (normalized.length === 1 && normalized[0].endsWith(".app"))) {
		return "outer-app";
	}
	if (normalized.some((segment) => segment.endsWith(".app"))) return "nested-app";
	return "ordinary";
}

export function resolveEntitlementsForPath(
	relativePath,
	{ outerEntitlements, inheritedEntitlements, emptyEntitlements } = {},
) {
	const target = classifySigningTarget(relativePath);
	if (target === "outer-app") return outerEntitlements;
	if (target === "nested-app") return inheritedEntitlements;
	return emptyEntitlements;
}

export function createSigningOptions({
	appPath,
	outerEntitlements,
	inheritedEntitlements,
	emptyEntitlements,
	identity = "-",
} = {}) {
	return {
		app: appPath,
		platform: "darwin",
		identity,
		identityValidation: false,
		hardenedRuntime: false,
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		strictVerify: true,
		timestamp: "none",
		entitlements: outerEntitlements,
		optionsForFile: (filePath) => ({
			entitlements: resolveEntitlementsForPath(relative(appPath, filePath) || ".", {
				outerEntitlements,
				inheritedEntitlements,
				emptyEntitlements,
			}),
			hardenedRuntime: false,
			timestamp: "none",
		}),
	};
}

async function runChecked(runCommand, command, args, options) {
	const result = await runCommand(command, args, options);
	if (typeof result?.status === "number" && result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
	}
	return result;
}

async function createSiblingAppPath(destination, prefix, { fs = defaultFileSystem, makeId = randomUUID } = {}) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const candidate = join(dirname(destination), `.${prefix}-${process.pid}-${makeId()}.app`);
		if (!(await pathExists(candidate, fs))) return candidate;
	}
	throw new Error(`Could not allocate a unique ${prefix} staging path beside ${destination}`);
}

async function loadSigner(injectedSigner) {
	if (injectedSigner) return typeof injectedSigner === "function" ? injectedSigner : injectedSigner.sign;
	const signerModule = await import("@electron/osx-sign");
	const signer = signerModule.sign ?? signerModule.default?.sign;
	if (typeof signer !== "function") throw new Error("@electron/osx-sign does not export sign()");
	return signer;
}

async function signAndVerifyStagedApp({
	appPath,
	packageRoot,
	fs = defaultFileSystem,
	runCommand = defaultRunCommand,
	signer,
}) {
	const entitlementsDirectory = await fs.mkdtemp(join(tmpdir(), "vetta-local-sign-"));
	const emptyEntitlements = join(entitlementsDirectory, "empty.plist");
	await fs.writeFile(
		emptyEntitlements,
		`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>\n`,
		"utf8",
	);
	const outerEntitlements = join(packageRoot, "build", "entitlements.mac.plist");
	const inheritedEntitlements = join(packageRoot, "build", "entitlements.mac.inherit.plist");
	try {
		const sign = await loadSigner(signer);
		if (typeof sign !== "function") throw new Error("Invalid @electron/osx-sign signer");
		await sign(
			createSigningOptions({
				appPath,
				outerEntitlements,
				inheritedEntitlements,
				emptyEntitlements,
				identity: "-",
			}),
		);
		await runChecked(runCommand, "codesign", ["--verify", "--deep", "--strict", appPath]);
	} finally {
		await fs.rm(entitlementsDirectory, { recursive: true, force: true });
	}
}

export function parseAppProcesses(output, appPath) {
	const bundlePrefix = `${appPath}${sep}`;
	const mainExecutable = join(appPath, "Contents", "MacOS", "Vetta");
	const processes = [];
	for (const line of String(output ?? "").split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(.+)$/);
		if (!match) continue;
		const command = match[2].trim();
		if (!command.startsWith(bundlePrefix)) continue;
		processes.push({
			pid: Number(match[1]),
			command,
			isMain: command === mainExecutable || command.startsWith(`${mainExecutable} `),
		});
	}
	return processes;
}

async function listAppProcessesDefault(appPath, { runCommand = defaultRunCommand } = {}) {
	const result = await runCommand("ps", ["-axo", "pid=,command="], { capture: true });
	return parseAppProcesses(result?.stdout, appPath);
}

async function getAppProcesses(appPath, dependencies, { mainOnly = false } = {}) {
	const processes = await (dependencies.listProcesses ?? listAppProcessesDefault)(appPath, dependencies);
	return (processes ?? [])
		.map((processInfo) =>
			typeof processInfo === "number"
				? { pid: processInfo, isMain: true }
				: { pid: Number(processInfo.pid), isMain: processInfo.isMain === true },
		)
		.filter(({ pid, isMain }) => Number.isInteger(pid) && pid > 0 && (!mainOnly || isMain))
		.map(({ pid }) => pid);
}

async function waitForAppProcesses(appPath, { expected, mainOnly = false, timeoutMs, pollIntervalMs, dependencies }) {
	const sleep = dependencies.sleep ?? defaultSleep;
	const attempts = Math.max(0, Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)));
	for (let attempt = 0; ; attempt += 1) {
		const processes = await getAppProcesses(appPath, dependencies, { mainOnly });
		if ((expected ? processes.length > 0 : processes.length === 0)) return processes;
		if (attempt >= attempts || timeoutMs <= 0) {
			throw new Error(
				expected
					? `Timed out waiting for Vetta.app to start: ${appPath}`
					: `Timed out waiting for Vetta.app processes to exit: ${appPath}`,
			);
		}
		await sleep(pollIntervalMs);
		// Keep the injected clock observable without making the production loop unbounded.
	}
}

export async function stopRunningApp(
	appPath,
	{
		dependencies = {},
		quitTimeoutMs = defaultTimings.quitTimeoutMs,
		pollIntervalMs = defaultTimings.pollIntervalMs,
		throwOnFailure = true,
		logger = defaultLogger,
	} = {},
) {
	const processes = await getAppProcesses(appPath, dependencies);
	if (processes.length === 0) return false;
	try {
		await (dependencies.runCommand ?? defaultRunCommand)("osascript", [
			"-e",
			'tell application id "com.vetta.desktop" to quit',
		]);
	} catch (error) {
		logger(`normal quit request failed; waiting before SIGTERM: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		await waitForAppProcesses(appPath, {
			expected: false,
			timeoutMs: quitTimeoutMs,
			pollIntervalMs,
			dependencies,
		});
		return true;
	} catch (waitError) {
		const remaining = await getAppProcesses(appPath, dependencies);
		for (const pid of remaining) (dependencies.killProcess ?? defaultKillProcess)(pid);
		try {
			await waitForAppProcesses(appPath, {
				expected: false,
				timeoutMs: quitTimeoutMs,
				pollIntervalMs,
				dependencies,
			});
			return true;
		} catch (termError) {
			if (throwOnFailure) {
				throw new Error(
					`Vetta.app did not exit; existing installation was left untouched. ${
						termError instanceof Error ? termError.message : String(waitError)
					}`,
				);
			}
			logger(`could not stop ${appPath}: ${termError instanceof Error ? termError.message : String(termError)}`);
			return false;
		}
	}
}

async function removeQuarantine(appPath, { runCommand = defaultRunCommand, logger = defaultLogger } = {}) {
	try {
		await runChecked(runCommand, "xattr", ["-dr", "com.apple.quarantine", appPath]);
	} catch (error) {
		logger(`could not remove quarantine metadata from ${appPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function reopenApp(appPath, { runCommand = defaultRunCommand, logger = defaultLogger } = {}) {
	try {
		await runChecked(runCommand, "open", [appPath]);
	} catch (error) {
		logger(`could not reopen ${appPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function replaceInstalledApp({
	stagedApp,
	destination,
	expectedVersion,
	packageRoot = packageDir,
	fs = defaultFileSystem,
	runCommand = defaultRunCommand,
	readMetadata,
	readPlist = readPlistValue,
	signer,
	listProcesses,
	killProcess,
	sleep,
	now,
	makeId = randomUUID,
	timings = defaultTimings,
	logger = defaultLogger,
} = {}) {
	const dependencies = {
		fs,
		runCommand,
		readMetadata,
		readPlist,
		listProcesses,
		killProcess,
		sleep,
		now,
	};
	const oldExists = await pathExists(destination, fs);
	await signAndVerifyStagedApp({
		appPath: stagedApp,
		packageRoot,
		fs,
		runCommand,
		signer,
	});
	await readAndAssertBundleMetadata(stagedApp, expectedVersion, dependencies);

	const backupPath = oldExists ? await createSiblingAppPath(destination, "Vetta.backup", { fs, makeId }) : undefined;
	let backupCreated = false;
	let candidateInstalled = false;
	try {
		await stopRunningApp(destination, {
			dependencies,
			quitTimeoutMs: timings.quitTimeoutMs,
			pollIntervalMs: timings.pollIntervalMs,
			logger,
		});
		if (oldExists) {
			await fs.rename(destination, backupPath);
			backupCreated = true;
		}
		await fs.rename(stagedApp, destination);
		candidateInstalled = true;
		await removeQuarantine(destination, { runCommand, logger });
		await runChecked(runCommand, "codesign", ["--verify", "--deep", "--strict", destination]);
		await readAndAssertBundleMetadata(destination, expectedVersion, dependencies);
		await runChecked(runCommand, "open", [destination]);
		await waitForAppProcesses(destination, {
			expected: true,
			mainOnly: true,
			timeoutMs: timings.startTimeoutMs,
			pollIntervalMs: timings.pollIntervalMs,
			dependencies,
		});
		if (timings.startStabilityMs > 0) await (sleep ?? defaultSleep)(timings.startStabilityMs);
		await waitForAppProcesses(destination, {
			expected: true,
			mainOnly: true,
			timeoutMs: 0,
			pollIntervalMs: timings.pollIntervalMs,
			dependencies,
		});
		let retainedBackupPath;
		if (backupCreated) {
			try {
				await fs.rm(backupPath, { recursive: true, force: true });
			} catch (cleanupError) {
				retainedBackupPath = backupPath;
				logger(
					`updated app is running, but the previous app backup could not be fully removed; ` +
						`inspect or remove ${backupPath} manually (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
				);
			}
			backupCreated = false;
		}
		return { destination, backupPath: retainedBackupPath };
	} catch (error) {
		const rollbackProblems = [];
		if (candidateInstalled || backupCreated) {
			try {
				await stopRunningApp(destination, {
					dependencies,
					quitTimeoutMs: timings.quitTimeoutMs,
					pollIntervalMs: timings.pollIntervalMs,
					throwOnFailure: false,
					logger,
				});
				const remaining = await getAppProcesses(destination, dependencies);
				if (remaining.length > 0) {
					throw new Error(`candidate still has running processes: ${remaining.join(", ")}`);
				}
				await fs.rm(destination, { recursive: true, force: true });
			} catch (rollbackError) {
				rollbackProblems.push(rollbackError);
			}
		}
		if (backupCreated && rollbackProblems.length === 0) {
			try {
				await fs.rename(backupPath, destination);
				backupCreated = false;
				await reopenApp(destination, { runCommand, logger });
			} catch (restoreError) {
				rollbackProblems.push(restoreError);
			}
		}
		if (rollbackProblems.length > 0) {
			const backupNotice = backupCreated
				? ` The previous installation is preserved at ${backupPath}.`
				: " No previous installation backup was available.";
			throw new AggregateError(
				[error, ...rollbackProblems],
				`Vetta.app replacement failed and rollback could not complete.${backupNotice}`,
			);
		}
		throw error;
	} finally {
		await fs.rm(stagedApp, { recursive: true, force: true });
	}
}

export async function runPackageAndInstall({
	argv = process.argv.slice(2),
	platform = process.platform,
	arch = process.arch,
	packageRoot = packageDir,
	releaseDir = join(packageRoot, "release"),
	home = homedir(),
	cwd = process.cwd(),
	env = process.env,
	fs = defaultFileSystem,
	runCommand = defaultRunCommand,
	readMetadata,
	readArchitectures,
	readPlist = readPlistValue,
	signer,
	listProcesses,
	killProcess,
	sleep,
	now,
	makeId = randomUUID,
	timings = defaultTimings,
	logger = defaultLogger,
} = {}) {
	if (platform !== "darwin") throw new Error("desktop:install:mac can only run on macOS (darwin)");
	if (!supportedArchitectures.has(arch)) {
		throw new Error(`Unsupported macOS architecture: ${arch}; only arm64 and x64 are supported`);
	}
	const options = parseArguments(argv);
	const destination = await resolveDestination({ destination: options.destination, home, fs, cwd });
	await assertDestinationParentWritable(destination, fs);
	const packageJson = JSON.parse(await fs.readFile(join(packageRoot, "package.json"), "utf8"));
	const expectedVersion = packageJson.version;
	if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
		throw new Error(`Could not read a valid Desktop version from ${join(packageRoot, "package.json")}`);
	}
	const buildEnvironment = createLocalBuildEnvironment(env, { arch, version: expectedVersion });
	const command = buildCommand({ arch, appOnly: options.appOnly });
	await runChecked(runCommand, command.command, command.args, { cwd: packageRoot, env: buildEnvironment });
	if (!options.appOnly) {
		await runChecked(runCommand, "bun", ["run", "verify:updates:mac"], { cwd: packageRoot, env: buildEnvironment });
	}

	const sourceApp = await resolveUnpackedApp({
		releaseDir,
		arch,
		expectedVersion,
		fs,
		readMetadata,
		readArchitectures,
		readPlist,
		runCommand,
	});
	const stagedApp = await createSiblingAppPath(destination, "Vetta.staging", { fs, makeId });
	try {
		await runChecked(runCommand, "ditto", [sourceApp, stagedApp]);
		await readAndAssertBundleMetadata(stagedApp, expectedVersion, {
			readMetadata,
			readPlist,
			runCommand,
		});
		await replaceInstalledApp({
			stagedApp,
			destination,
			expectedVersion,
			packageRoot,
			fs,
			runCommand,
			readMetadata,
			readPlist,
			signer,
			listProcesses,
			killProcess,
			sleep,
			now,
			makeId,
			timings,
			logger,
		});
	} finally {
		await fs.rm(stagedApp, { recursive: true, force: true });
	}
	logger(`installed Vetta ${expectedVersion} at ${destination}`);
	return { destination, sourceApp, version: expectedVersion, appOnly: options.appOnly };
}

export async function main(argv = process.argv.slice(2)) {
	await runPackageAndInstall({ argv });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`[package-and-install-mac] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
