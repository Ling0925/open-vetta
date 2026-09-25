import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_BUNDLE = JSON.parse(
	readFileSync(new URL("../src/shared/codex-bundle.json", import.meta.url), "utf8"),
);
export function codexBundleTarget(tag) {
	if (!Object.hasOwn(CODEX_BUNDLE.targets, tag)) throw new Error(`Unsupported Codex preview target: ${tag}`);
	return CODEX_BUNDLE.targets[tag];
}
function inside(root, path) {
	const difference = relative(realpathSync(root), realpathSync(path));
	return difference && !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

function validateDistribution(root, directory = root) {
	for (const name of readdirSync(directory)) {
		const file = join(directory, name);
		const stat = lstatSync(file);
		// Avoid copying host files through an unexpected package symlink.
		if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
			throw new Error("Unsupported linked Codex distribution entry");
		if (stat.isDirectory()) validateDistribution(root, file);
	}
}

/** Resolve dependencies from the canonical package path (Bun may link its package store).
 * Accept only the two known native distribution layouts, retaining either layout intact. */
export function resolveCodexDistribution(installRoot, target, probe = verifyCodexExecutable) {
	const definition = codexBundleTarget(target);
	const packageRoot = realpathSync(join(installRoot, "node_modules", "@openai", "codex"));
	if (!inside(installRoot, packageRoot)) throw new Error("Codex package is outside its temporary installation");
	const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (metadata.name !== "@openai/codex" || metadata.version !== CODEX_BUNDLE.version)
		throw new Error("Codex package version mismatch");
	const require = createRequire(join(packageRoot, "package.json"));
	let nativeRoot;
	try {
		nativeRoot = dirname(require.resolve(`${definition.package}/package.json`));
	} catch (error) {
		if (error.code !== "MODULE_NOT_FOUND") throw error;
		nativeRoot = packageRoot;
	}
	const vendor = join(nativeRoot, "vendor", definition.triple);
	if (!inside(installRoot, vendor)) throw new Error("Codex vendor directory is outside its temporary installation");
	const binary = distributionExecutable(vendor, definition);
	validateDistribution(vendor);
	probe(binary);
	const notices = readPinnedCodexNotices();
	const additionalNotices = [];
	for (const [prefix, root] of [
		["npm", packageRoot],
		["native", nativeRoot],
	]) {
		for (const name of ["LICENSE", "LICENSE.txt", "NOTICE"]) {
			const path = join(root, name);
			if (!existsSync(path)) continue;
			if (!inside(installRoot, path) || lstatSync(path).isSymbolicLink()) throw new Error("Invalid Codex notice file");
			additionalNotices.push({ name: `${prefix}-${name}`, content: readNoticeFile(path) });
		}
	}
	return { vendor, binary, notices, additionalNotices };
}

function readNoticeFile(path) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error("Invalid Codex notice file");
	return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

/** npm's native payload need not include root notices. Ship the exact upstream release texts,
 * checked against its Git blobs; never omit attribution to make packaging succeed. */
export function readPinnedCodexNotices(root = fileURLToPath(new URL("../resources/codex-notices", import.meta.url))) {
	const source = JSON.parse(readNoticeFile(join(root, "source.json")));
	if (source.version !== CODEX_BUNDLE.version) throw new Error("Codex notice version mismatch");
	const notices = {};
	for (const name of ["LICENSE", "NOTICE"]) {
		const content = readNoticeFile(join(root, name));
		const blob = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
		if (blob !== source.gitBlobs?.[name]) throw new Error("Codex upstream notice checksum mismatch");
		notices[name] = content;
	}
	return { ...notices, "SOURCE.json": `${JSON.stringify(source, null, 2)}\n` };
}

function distributionExecutable(vendor, definition) {
	const candidates = CODEX_BUNDLE.binaryDirectories.map((directory) => join(vendor, directory, definition.binary));
	const found = candidates.filter(existsSync);
	if (found.length !== 1)
		throw new Error("Missing or ambiguous native Codex executable in the fixed distribution layouts");
	const binary = found[0];
	if (!lstatSync(binary).isFile() || lstatSync(binary).isSymbolicLink() || !inside(vendor, binary))
		throw new Error("Invalid native Codex executable");
	return binary;
}

/** Stage the entire native distribution, including adjacent sandbox tools, outside app.asar. */
export function stageCodexRuntime({ installRoot, stageRoot, target, probe = verifyCodexExecutable }) {
	const definition = codexBundleTarget(target);
	const { vendor, binary, notices, additionalNotices } = resolveCodexDistribution(installRoot, target, probe);
	const destination = join(stageRoot, "codex-runtime");
	if (existsSync(destination)) throw new Error("Codex staging destination already exists");
	const configPath = join(stageRoot, "electron-builder.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	if (
		!Array.isArray(config.extraResources) ||
		config.extraResources.some((item) => typeof item === "object" && item?.to === "codex-runtime")
	) {
		throw new Error("Unexpected existing Codex packaging resource");
	}
	try {
		mkdirSync(destination);
		cpSync(vendor, join(destination, definition.triple), { recursive: true, dereference: true });
		for (const [name, content] of Object.entries(notices)) writeFileSync(join(destination, name), content);
		for (const notice of additionalNotices) writeFileSync(join(destination, notice.name), notice.content);
		writeFileSync(
			join(destination, "manifest.json"),
			`${JSON.stringify({ schemaVersion: CODEX_BUNDLE.schemaVersion, version: CODEX_BUNDLE.version, target }, null, 2)}\n`,
		);
		config.extraResources.push({ from: "codex-runtime", to: "codex-runtime", filter: ["**/*"] });
		writeFileSync(`${configPath}.codex.tmp`, `${JSON.stringify(config, null, 2)}\n`);
		renameSync(`${configPath}.codex.tmp`, configPath);
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		rmSync(`${configPath}.codex.tmp`, { force: true });
		throw error;
	}
	return join(destination, definition.triple, relative(vendor, binary));
}

export function verifyCodexExecutable(executable) {
	const environment = Object.fromEntries(
		["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TMP", "TEMP", "TMPDIR"].flatMap((key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key]]],
		),
	);
	const result = execFileSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 4096,
		windowsHide: true,
		env: environment,
	});
	if (result.trim() !== `codex-cli ${CODEX_BUNDLE.version}`)
		throw new Error("Bundled Codex executable version mismatch");
}

export function verifyPackagedCodex(resourcesPath, target) {
	const definition = codexBundleTarget(target);
	const root = join(resourcesPath, "codex-runtime");
	const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
	if (
		manifest.version !== CODEX_BUNDLE.version ||
		manifest.schemaVersion !== CODEX_BUNDLE.schemaVersion ||
		manifest.target !== target
	)
		throw new Error("Packaged Codex manifest mismatch");
	for (const [name, expected] of Object.entries(readPinnedCodexNotices())) {
		if (readNoticeFile(join(root, name)) !== expected) throw new Error("Packaged Codex notices mismatch");
	}
	verifyCodexExecutable(distributionExecutable(join(root, definition.triple), definition));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	if (process.argv.length !== 4) throw new Error("Usage: node stage-codex-runtime.mjs RESOURCES_PATH PLATFORM-ARCH");
	verifyPackagedCodex(process.argv[2], process.argv[3]);
}
