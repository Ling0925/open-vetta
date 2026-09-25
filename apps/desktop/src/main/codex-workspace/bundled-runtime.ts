import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import bundle from "../../shared/codex-bundle.json";
import type { CodexRuntimeDefaults } from "../../shared/codex-workspace.js";
import { CodexWorkspaceError } from "./validation.js";

export function managedCodexHome(runtimeRoot: string): string {
	return join(runtimeRoot, "home");
}

/** Read installed resources only. Visiting the page must not install, launch, authenticate or save anything. */
export async function readBundledCodexDefaults(
	resourcesPath: string,
	runtimeRoot: string,
	platform = process.platform as string,
	arch = process.arch as string,
): Promise<CodexRuntimeDefaults | undefined> {
	const root = join(resourcesPath, "codex-runtime");
	const manifestPath = join(root, "manifest.json");
	let stat: Stats;
	try {
		stat = await lstat(manifestPath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new CodexWorkspaceError("CODEX_BUNDLE_INVALID");
	}
	try {
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("manifest");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		const target = `${platform}-${arch}`;
		if (!Object.hasOwn(bundle.targets, target)) throw new Error("platform");
		const definition = bundle.targets[target as keyof typeof bundle.targets];
		if (
			!manifest ||
			typeof manifest !== "object" ||
			Array.isArray(manifest) ||
			!("schemaVersion" in manifest) ||
			manifest.schemaVersion !== bundle.schemaVersion ||
			!("version" in manifest) ||
			manifest.version !== bundle.version ||
			!("target" in manifest) ||
			manifest.target !== target
		)
			throw new Error("identity");
		// The executable path comes from compiled application policy, never from the manifest or project.
		const candidates = await Promise.all(
			bundle.binaryDirectories.map(async (directory) => {
				const path = join(root, definition.triple, directory, definition.binary);
				try {
					await lstat(path);
					return path;
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
					throw error;
				}
			}),
		);
		const available = candidates.filter((path): path is string => path !== undefined);
		if (available.length !== 1) throw new Error("missing or ambiguous executable");
		const executable = available[0];
		const file = await lstat(executable);
		if (!file.isFile() || file.isSymbolicLink()) throw new Error("executable");
		const rootStat = await lstat(root);
		const canonicalRoot = await realpath(root);
		if (
			!rootStat.isDirectory() ||
			rootStat.isSymbolicLink() ||
			relative(await realpath(resourcesPath), canonicalRoot) !== "codex-runtime"
		)
			throw new Error("bundle root");
		const canonicalExecutable = await realpath(executable);
		const difference = relative(canonicalRoot, canonicalExecutable);
		if (isAbsolute(difference) || difference === ".." || difference.startsWith(`..${sep}`)) throw new Error("escape");
		await access(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
		return { executable, expectedVersion: bundle.version, codexHome: managedCodexHome(runtimeRoot) };
	} catch {
		throw new CodexWorkspaceError("CODEX_BUNDLE_INVALID");
	}
}

/** Called only after the user confirms Save. Manual paths retain their existing semantics. */
export async function prepareManagedCodexHome(configuredHome: string, runtimeRoot: string): Promise<void> {
	const home = managedCodexHome(runtimeRoot);
	if (configuredHome !== home) return;
	await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
	try {
		await mkdir(home, { mode: 0o700 });
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const stat = await lstat(home);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		relative(await realpath(runtimeRoot), await realpath(home)) !== "home"
	) {
		throw new CodexWorkspaceError("CODEX_HOME_INVALID");
	}
}
