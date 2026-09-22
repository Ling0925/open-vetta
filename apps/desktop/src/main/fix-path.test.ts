import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BoundedProcessResult, type BoundedProcessSpawner, runBoundedProcess } from "./bounded-process.js";
import { fixPath, startAfterPathReady } from "./fix-path.js";

vi.mock("./logger.js", () => ({
	getAppLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const successfulResult = (stdout: string): BoundedProcessResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
	timedOut: false,
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

function fakeChildProcess(): {
	readonly child: ChildProcess;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	readonly events: EventEmitter;
	readonly kill: ReturnType<typeof vi.fn>;
} {
	const events = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const kill = vi.fn(() => true);
	const child = Object.assign(events, { stdout, stderr, kill }) as unknown as ChildProcess;
	return { child, stdout, stderr, events, kill };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("fixPath", () => {
	it("sources an interactive login shell and appends only missing PATH entries", async () => {
		const env: NodeJS.ProcessEnv = {
			PATH: ["/managed/bin", "/existing/bin"].join(delimiter),
			SHELL: "/controlled/login-shell",
		};
		const resolvedPath = ["/existing/bin", "/homebrew/bin", "/homebrew/bin", "/user/bin"].join(delimiter);
		const runProcess = vi.fn(
			async (
				_shell: string,
				_args: readonly string[],
				_options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly stderr: "ignore" },
			) => successfulResult(`profile banner\n__VETTA_PATH_MARKER__${resolvedPath}__VETTA_PATH_MARKER__`),
		);

		await fixPath({ platform: "darwin", env, runProcess });

		expect(env.PATH).toBe(["/managed/bin", "/existing/bin", "/homebrew/bin", "/user/bin"].join(delimiter));
		expect(runProcess).toHaveBeenCalledOnce();
		const [shell, args, options] = runProcess.mock.calls[0];
		expect(shell).toBe("/controlled/login-shell");
		expect(args[0]).toBe("-ilc");
		expect(args[1]).toContain('"$PATH"');
		expect(options).toMatchObject({ env, timeoutMs: 5000, stderr: "ignore" });
	});

	it("leaves PATH unchanged when the login shell times out or fails", async () => {
		const initialPath = ["/managed/bin", "/system/bin"].join(delimiter);
		const timedOutEnv: NodeJS.ProcessEnv = { PATH: initialPath, SHELL: "/controlled/timeout-shell" };
		await expect(
			fixPath({
				platform: "darwin",
				env: timedOutEnv,
				runProcess: async () => ({
					exitCode: null,
					stdout: "",
					stderr: "",
					timedOut: true,
					error: new Error("timed out"),
				}),
			}),
		).resolves.toBeUndefined();
		expect(timedOutEnv.PATH).toBe(initialPath);

		const failedEnv: NodeJS.ProcessEnv = { PATH: initialPath, SHELL: "/controlled/error-shell" };
		await expect(
			fixPath({
				platform: "darwin",
				env: failedEnv,
				runProcess: async () => {
					throw new Error("spawn failed");
				},
			}),
		).resolves.toBeUndefined();
		expect(failedEnv.PATH).toBe(initialPath);
	});

	it("lets the visible startup stage advance while PATH work is pending and gates dependent work", async () => {
		const probe = deferred<BoundedProcessResult>();
		const env: NodeJS.ProcessEnv = { PATH: "/system/bin", SHELL: "/controlled/deferred-shell" };
		const order: string[] = ["probe-started"];
		const pathReady = fixPath({ platform: "darwin", env, runProcess: () => probe.promise });
		const dependentStartup = startAfterPathReady(pathReady, () => {
			order.push("path-dependent-started");
		});

		await Promise.resolve().then(() => order.push("visible-shell"));
		expect(order).toEqual(["probe-started", "visible-shell"]);

		probe.resolve(successfulResult("__VETTA_PATH_MARKER__/system/bin:/user/bin__VETTA_PATH_MARKER__"));
		await dependentStartup;

		expect(order).toEqual(["probe-started", "visible-shell", "path-dependent-started"]);
		expect(env.PATH).toBe(["/system/bin", "/user/bin"].join(delimiter));
	});
});

describe("runBoundedProcess", () => {
	it("collects probe output with stdin closed", async () => {
		const fake = fakeChildProcess();
		let spawnOptions: SpawnOptions | undefined;
		const spawnProcess: BoundedProcessSpawner = (_command, _args, options) => {
			spawnOptions = options;
			return fake.child;
		};
		const resultPromise = runBoundedProcess("controlled-probe", [], { timeoutMs: 5000, spawnProcess });

		fake.stdout.end("version-output");
		fake.stderr.end("diagnostic-output");
		fake.events.emit("close", 0);

		await expect(resultPromise).resolves.toMatchObject({
			exitCode: 0,
			stdout: "version-output",
			stderr: "diagnostic-output",
			timedOut: false,
		});
		expect(spawnOptions?.stdio).toEqual(["ignore", "pipe", "pipe"]);
	});

	it("does not block the event loop and settles a hanging probe at its timeout", async () => {
		vi.useFakeTimers();
		const fake = fakeChildProcess();
		const resultPromise = runBoundedProcess("controlled-hanging-probe", [], {
			timeoutMs: 5000,
			spawnProcess: () => fake.child,
		});
		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		let eventLoopAdvanced = false;
		await Promise.resolve().then(() => {
			eventLoopAdvanced = true;
		});
		expect(eventLoopAdvanced).toBe(true);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(5000);
		await expect(resultPromise).resolves.toMatchObject({ exitCode: null, timedOut: true });
		expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it.runIf(process.platform !== "win32")(
		"kills descendants when a real bounded probe exceeds its output limit",
		async () => {
			const testRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "vetta-bounded-process-"));
			const descendantPidPath = join(testRoot, "descendant.pid");
			const script = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 600000)"], { stdio: "ignore" });',
				`writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
				'process.stdout.write("x".repeat(4096));',
				"setInterval(() => {}, 600000);",
			].join("\n");
			let descendantPid: number | undefined;

			try {
				const result = await runBoundedProcess(process.execPath, ["-e", script], {
					timeoutMs: 5000,
					maxOutputBytes: 64,
				});
				descendantPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);

				expect(result.error?.message).toContain("Process output exceeded");
				expect(() => process.kill(descendantPid ?? 0, 0)).toThrow();
			} finally {
				if (descendantPid !== undefined) {
					try {
						process.kill(descendantPid, "SIGKILL");
					} catch {
						// Expected when the process-group cleanup worked.
					}
				}
				await rm(testRoot, { recursive: true, force: true });
			}
		},
	);
});
