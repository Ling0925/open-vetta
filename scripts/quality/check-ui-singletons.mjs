import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { isDirectRun, repoRoot } from "./lib.mjs";

// Both packages keep module-local state which must be shared by nested overlays.
const SINGLETONS = new Set(["@radix-ui/react-focus-scope", "@radix-ui/react-dismissable-layer"]);
const UI_MANIFESTS = [
	"package.json",
	"apps/desktop/package.json",
	"packages/ui/package.json",
	"packages/theme-ui/package.json",
];

function isOverlayDependency(name) {
	return name === "radix-ui" || name === "vaul" || name.startsWith("@radix-ui/");
}

function readManifest(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function dependencyManifest(entry, name) {
	let directory = dirname(entry);
	while (true) {
		const path = join(directory, "package.json");
		if (existsSync(path) && readManifest(path).name === name) return path;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`Cannot locate manifest for ${name}: ${entry}`);
		directory = parent;
	}
}

/** Inspect installed module identity, not just versions: hoisted copies can have equal versions. */
export function checkUiSingletons(root = repoRoot, manifests = UI_MANIFESTS) {
	const instances = new Map([...SINGLETONS].map((name) => [name, new Set()]));
	const visited = new Set();
	const errors = [];

	function visit(manifestPath) {
		const canonical = realpathSync(manifestPath);
		if (visited.has(canonical)) return;
		visited.add(canonical);
		const manifest = readManifest(canonical);
		const require = createRequire(canonical);
		for (const name of Object.keys(manifest.dependencies ?? {}).filter(isOverlayDependency)) {
			let entry;
			try {
				entry = realpathSync(require.resolve(name));
			} catch {
				errors.push(`${relative(root, canonical)}: cannot resolve ${name}; run bun install first`);
				continue;
			}
			instances.get(name)?.add(relative(root, entry).replaceAll("\\", "/"));
			visit(dependencyManifest(entry, name));
		}
	}

	for (const manifest of manifests) visit(join(root, manifest));
	for (const [name, paths] of instances) {
		if (paths.size <= 1) continue;
		errors.push(
			`${name} has multiple runtime instances; nested overlays would use independent focus/pointer locks:\n${[
				...paths,
			]
				.sort()
				.map((path) => `  ${path}`)
				.join("\n")}`,
		);
	}
	return errors;
}

if (isDirectRun(import.meta.url)) {
	const errors = checkUiSingletons();
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("[ui-singletons] ok");
	}
}
