import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundedProcessResult } from "../bounded-process.js";
import {
	type DetectSystemRuntimeOptions,
	detectSystemRuntime,
	RuntimeManager,
	type SystemRuntimeDetection,
} from "./manager.js";
import { binDirsFor, executablePathFor, npmGlobalBinDir, registryPath, runtimeVersion } from "./paths.js";

vi.mock("../logger.js", () => ({
	getAppLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const originalEnv = { ...process.env };
let testRoot = "";

function commandResult(
	exitCode: number | null,
	stdout = "",
	stderr = "",
	extra: Partial<BoundedProcessResult> = {},
): BoundedProcessResult {
	return { exitCode, stdout, stderr, timedOut: false, ...extra };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}

beforeEach(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "vetta-runtime-manager-"));
	process.env.VETTA_CODING_AGENT_DIR = join(testRoot, "agent");
});

afterEach(async () => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) delete process.env[key];
	}
	Object.assign(process.env, originalEnv);
	await rm(testRoot, { recursive: true, force: true });
});

describe("detectSystemRuntime", () => {
	it("uses the PATH snapshot, tries python3 before python, and records the located executable", async () => {
		const executable = join(testRoot, "bin", "python");
		const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
		const runCommand = vi.fn(
			async (
				command: string,
				args: readonly string[],
				options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
			): Promise<BoundedProcessResult> => {
				calls.push({ command, args, env: options.env, timeoutMs: options.timeoutMs });
				if (command === "python3") return commandResult(1, "", "not found");
				if (command === "python") return commandResult(0, "", "Python 3.13.9\n");
				return commandResult(0, `${executable}\n${join(testRoot, "other", "python")}\n`);
			},
		);

		await expect(
			detectSystemRuntime("python", {
				systemPath: "/snapshot/bin",
				baseEnv: { PATH: "/mutated/bin", KEEP_ME: "yes" },
				platform: "darwin",
				pathExists: (path) => path === executable,
				runCommand,
			}),
		).resolves.toEqual({ path: executable, version: "3.13.9" });

		expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
			["python3", "--version"],
			["python", "--version"],
			["which", "python"],
		]);
		expect(
			calls.every(
				({ env, timeoutMs }) => env.PATH === "/snapshot/bin" && env.Path === "/snapshot/bin" && timeoutMs === 5000,
			),
		).toBe(true);
		expect(calls[0].env.KEEP_ME).toBe("yes");
	});

	it("treats timeout and spawn errors as a missing system runtime", async () => {
		for (const failure of [
			commandResult(null, "", "", { timedOut: true, error: new Error("timed out") }),
			commandResult(null, "", "", { error: new Error("spawn failed") }),
		]) {
			const runCommand = vi.fn(async () => failure);
			await expect(
				detectSystemRuntime("node", {
					systemPath: "/snapshot/bin",
					runCommand,
				}),
			).resolves.toBeUndefined();
			expect(runCommand).toHaveBeenCalledOnce();
		}
	});
});

describe("RuntimeManager system detection lifecycle", () => {
	it("keeps initialization asynchronous and reuses one process-wide detection", async () => {
		const gate = deferred<void>();
		const probe = vi.fn(
			async (
				_type: "node" | "python",
				_options: DetectSystemRuntimeOptions,
			): Promise<SystemRuntimeDetection | undefined> => {
				await gate.promise;
				return undefined;
			},
		);
		const manager = new RuntimeManager({
			detectSystemRuntime: probe,
			systemPathSnapshot: "/startup/snapshot",
		});

		const first = manager.initialize();
		const second = manager.initialize();
		expect(first).toBe(second);
		expect(probe).toHaveBeenCalledTimes(2);

		let eventLoopAdvanced = false;
		await Promise.resolve().then(() => {
			eventLoopAdvanced = true;
		});
		expect(eventLoopAdvanced).toBe(true);

		gate.resolve();
		await Promise.all([first, second]);
		await manager.initialize();

		expect(probe).toHaveBeenCalledTimes(2);
		expect(probe.mock.calls.map(([, options]) => options.systemPath)).toEqual([
			"/startup/snapshot",
			"/startup/snapshot",
		]);
	});

	it("merges concurrent redetects but starts a fresh probe for the next manual redetect", async () => {
		let generation = 1;
		let gate = deferred<void>();
		const probe = vi.fn(async (type: "node" | "python"): Promise<SystemRuntimeDetection> => {
			const currentGeneration = generation;
			await gate.promise;
			return { path: join(testRoot, `system-${currentGeneration}`, type), version: `1.0.${currentGeneration}` };
		});
		const manager = new RuntimeManager({ detectSystemRuntime: probe, now: () => 1234 });

		const first = manager.redetect();
		const concurrent = manager.redetect();
		expect(first).toBe(concurrent);
		expect(probe).toHaveBeenCalledTimes(2);
		gate.resolve();
		const firstStatus = await first;
		expect(firstStatus.node.system?.version).toBe("1.0.1");
		expect(firstStatus.python.system?.version).toBe("1.0.1");

		generation = 2;
		gate = deferred<void>();
		const next = manager.redetect();
		expect(probe).toHaveBeenCalledTimes(4);
		gate.resolve();
		const nextStatus = await next;
		expect(nextStatus.node.system?.version).toBe("1.0.2");
		expect(nextStatus.python.system?.version).toBe("1.0.2");

		const registry = JSON.parse(await readFile(registryPath(), "utf8")) as {
			version: number;
			systemDetection: Record<string, { detectedAt: number }>;
		};
		expect(registry.version).toBe(1);
		expect(registry.systemDetection.node.detectedAt).toBe(1234);
		expect(registry.systemDetection.python.detectedAt).toBe(1234);
	});

	it("keeps managed runtimes ahead of the resolved login PATH and reports installed status", async () => {
		for (const type of ["node", "python"] as const) {
			const executable = executablePathFor(type);
			await mkdir(dirname(executable), { recursive: true });
			await writeFile(executable, "controlled runtime", "utf8");
		}
		const managedDirs =
			process.platform === "win32"
				? [npmGlobalBinDir(), ...binDirsFor("node"), ...binDirsFor("python")]
				: [...binDirsFor("node"), ...binDirsFor("python"), npmGlobalBinDir()];
		process.env.PATH = ["/login/bin", ...[...managedDirs].reverse(), "/system/bin"].join(delimiter);
		const manager = new RuntimeManager();

		manager.applyEnv();
		manager.applyEnv();

		expect(process.env.PATH?.split(delimiter)).toEqual([...managedDirs, "/login/bin", "/system/bin"]);
		expect(new Set(process.env.PATH?.split(delimiter)).size).toBe(process.env.PATH?.split(delimiter).length);
		expect(manager.getStatus()).toMatchObject({
			node: { ready: true, managedVersion: runtimeVersion("node"), activeSource: "managed" },
			python: { ready: true, managedVersion: runtimeVersion("python"), activeSource: "managed" },
		});
	});
});
