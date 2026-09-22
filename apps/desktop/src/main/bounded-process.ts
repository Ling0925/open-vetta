import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface BoundedProcessResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly error?: Error;
}

export type BoundedProcessSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface BoundedProcessOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	readonly stderr?: "pipe" | "ignore";
	readonly maxOutputBytes?: number;
	readonly spawnProcess?: BoundedProcessSpawner;
}

const spawnProcess: BoundedProcessSpawner = (command, args, options) => spawn(command, [...args], options);

function stopProcessTree(child: ChildProcess): void {
	child.stdout?.destroy();
	child.stderr?.destroy();
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			// POSIX children are spawned as detached process-group leaders below.
			// Kill the whole group so profile hooks cannot leave grandchildren behind.
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// The process may have exited between the deadline and this signal.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

/** Run a short probe without blocking the main thread, with closed stdin and bounded time/output. */
export function runBoundedProcess(
	command: string,
	args: readonly string[],
	options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
	return new Promise((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		let outputBytes = 0;
		let child: ChildProcess | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const finish = (result: BoundedProcessResult): void => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			resolve(result);
		};
		const collectedResult = (exitCode: number | null, timedOut: boolean, error?: Error): BoundedProcessResult => ({
			exitCode,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
			timedOut,
			...(error === undefined ? {} : { error }),
		});
		const append = (chunks: Buffer[], chunk: unknown): void => {
			if (settled) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			outputBytes += buffer.byteLength;
			if (outputBytes > maxOutputBytes) {
				if (child !== undefined) stopProcessTree(child);
				finish(collectedResult(null, false, new Error(`Process output exceeded ${maxOutputBytes} bytes`)));
				return;
			}
			chunks.push(buffer);
		};

		try {
			child = (options.spawnProcess ?? spawnProcess)(command, args, {
				env: options.env,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", options.stderr ?? "pipe"],
			});
		} catch (error) {
			finish(collectedResult(null, false, error instanceof Error ? error : new Error(String(error))));
			return;
		}

		child.stdout?.on("data", (chunk: unknown) => append(stdoutChunks, chunk));
		child.stderr?.on("data", (chunk: unknown) => append(stderrChunks, chunk));
		child.once("error", (error: Error) => finish(collectedResult(null, false, error)));
		child.once("close", (exitCode) => finish(collectedResult(exitCode, false)));

		timeout = setTimeout(() => {
			if (child !== undefined) stopProcessTree(child);
			finish(collectedResult(null, true, new Error(`Process timed out after ${options.timeoutMs}ms`)));
		}, options.timeoutMs);
		timeout.unref?.();
	});
}
