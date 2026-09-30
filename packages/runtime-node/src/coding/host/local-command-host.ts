import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import type { ForegroundCommandOperations } from "@vetta/runtime-tools";
import type {
	BackgroundCommandHost,
	BackgroundCommandOutputStore,
	BackgroundCommandProcessOperations,
} from "../shared/background-command-host.js";
import type { ForegroundCommandExecutorOptions } from "../shared/foreground-command-executor.js";
import { killNodeProcessTree } from "./process-tree.js";

export interface NodeShellCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly commandPrefix?: string;
}

export interface NodeForegroundCommandHostOptions {
	readonly resolveShell: () => NodeShellCommand;
	readonly environment?: () => NodeJS.ProcessEnv;
	readonly protectedDirectories?: readonly string[];
}

export interface NodeBackgroundCommandHostOptions {
	readonly resolveShell: () => NodeShellCommand;
	readonly normalizeOutput?: (value: string) => string;
}

export function createNodeForegroundCommandHost(
	options: NodeForegroundCommandHostOptions,
): ForegroundCommandExecutorOptions {
	return {
		operations: createForegroundOperations(options.resolveShell, options.environment),
		environment: options.environment,
		protectedDirectories: options.protectedDirectories,
		commandPrefix: options.resolveShell().commandPrefix,
	};
}

export function createNodeBackgroundCommandHost(options: NodeBackgroundCommandHostOptions): BackgroundCommandHost {
	return {
		processOperations: createBackgroundProcessOperations(options),
		outputStore: localBackgroundCommandOutputStore,
	};
}

function createForegroundOperations(
	resolveShell: () => NodeShellCommand,
	readEnvironment: (() => NodeJS.ProcessEnv) | undefined,
): ForegroundCommandOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			return new Promise((resolveExecution, rejectExecution) => {
				if (signal?.aborted) {
					rejectExecution(new Error("aborted"));
					return;
				}
				if (!existsSync(cwd)) {
					rejectExecution(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const shell = resolveShell();
				const child = spawn(shell.executable, [...shell.args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: { ...(env ?? readEnvironment?.() ?? process.env) },
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				let cancellationError: Error | undefined;
				let settled = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const cleanup = () => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					child.stdout?.destroy();
					child.stderr?.destroy();
				};
				const resolveOnce = (exitCode: number | null) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolveExecution({ exitCode });
				};
				const rejectOnce = (error: Error) => {
					if (settled) return;
					settled = true;
					cleanup();
					rejectExecution(error);
				};
				const stop = () => {
					if (child.pid) killNodeProcessTree(child.pid);
					else child.kill();
				};
				const requestStop = (error: Error) => {
					if (settled || cancellationError) return;
					cancellationError = error;
					stop();
				};
				const onAbort = () => requestStop(new Error("aborted"));

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						requestStop(new Error(`timeout:${timeout}`));
					}, timeout * 1_000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.once("error", (error) => {
					// A failed spawn has no process to retain. Errors on an existing
					// cancelled process do not establish that its resources are closed.
					if (cancellationError && child.pid) return;
					rejectOnce(cancellationError ?? error);
				});
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				child.once("exit", (exitCode) => {
					if (cancellationError) return;
					// Daemonizing commands can leave descendants holding the inherited
					// output pipes after the command shell itself exits. Flush queued data
					// for one turn, then settle from `exit` instead of waiting forever for
					// `close`; `close` remains the fast path for ordinary commands.
					setImmediate(() => {
						if (!cancellationError) resolveOnce(exitCode);
					});
				});
				child.once("close", (exitCode) => {
					if (cancellationError) rejectOnce(cancellationError);
					else resolveOnce(exitCode);
				});
			});
		},
	};
}

function createBackgroundProcessOperations(
	options: NodeBackgroundCommandHostOptions,
): BackgroundCommandProcessOperations {
	return {
		supportsInteractiveInput: process.platform !== "win32",
		spawn(request) {
			if (request.interactive && process.platform === "win32") {
				throw new Error("Interactive command input is not supported on Windows.");
			}
			const shell = options.resolveShell();
			const child = spawn(shell.executable, [...shell.args, request.command], {
				cwd: request.cwd,
				detached: process.platform !== "win32",
				env: request.env,
				stdio: [request.interactive ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const stdoutDecoder = new TextDecoder();
			const stderrDecoder = new TextDecoder();
			const emitOutput = (decoded: string): void => {
				if (!decoded) return;
				const text = (options.normalizeOutput?.(decoded) ?? decoded).replaceAll("\r", "");
				if (text) request.onOutput(text);
			};
			let settled = false;
			let exited = false;
			let stopping = false;
			let inputClosed = false;
			let inputError: Error | undefined;
			let resolveCompletion!: () => void;
			const completion = new Promise<void>((resolve) => {
				resolveCompletion = resolve;
			});
			// A failed write can emit `error` after its callback has rejected. Keep
			// an owner for that event even when no write operation is waiting.
			child.stdin?.on("error", (error) => {
				inputError = error;
			});
			const cleanup = (): void => {
				emitOutput(stdoutDecoder.decode());
				emitOutput(stderrDecoder.decode());
				child.stdin?.destroy();
				child.stdout?.destroy();
				child.stderr?.destroy();
				resolveCompletion();
			};
			const settleExit = (exitCode: number | null): void => {
				if (settled) return;
				settled = true;
				cleanup();
				request.onExit(exitCode ?? undefined);
			};
			const settleError = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				request.onError(error);
			};
			const stop = (): void => {
				if (settled || stopping) return;
				stopping = true;
				if (child.pid) killNodeProcessTree(child.pid);
				else child.kill();
			};
			child.stdout?.on("data", (data: Buffer) => {
				if (!settled) emitOutput(stdoutDecoder.decode(data, { stream: true }));
			});
			child.stderr?.on("data", (data: Buffer) => {
				if (!settled) emitOutput(stderrDecoder.decode(data, { stream: true }));
			});
			child.stdout?.once("end", () => {
				if (!settled) emitOutput(stdoutDecoder.decode());
			});
			child.stderr?.once("end", () => {
				if (!settled) emitOutput(stderrDecoder.decode());
			});
			child.once("exit", (exitCode) => {
				exited = true;
				if (request.interactive) {
					// The shell can exit before its children. Interactive sessions own
					// the process group until its inherited pipes close after termination.
					if (child.pid) killNodeProcessTree(child.pid);
				} else {
					setImmediate(() => settleExit(exitCode));
				}
			});
			child.once("close", settleExit);
			child.once("error", settleError);
			return {
				stop,
				async writeInput(text, close, signal) {
					const stdin = child.stdin;
					if (!stdin) throw new Error("Interactive stdin was not enabled for this command.");
					if (settled || exited) throw new Error("Command has exited.");
					if (stopping) throw new Error("Command is stopping.");
					if (inputError) throw inputError;
					if (inputClosed || stdin.destroyed || stdin.writableEnded) throw new Error("Command stdin is closed.");
					await new Promise<void>((resolve, reject) => {
						let finished = false;
						let cancelling = false;
						const finish = (error?: Error | null): void => {
							if (finished) return;
							finished = true;
							signal?.removeEventListener("abort", onAbort);
							stdin.removeListener("error", onError);
							stdin.removeListener("close", onClose);
							if (error) reject(error);
							else resolve();
						};
						const onWritten = (error?: Error | null): void => {
							if (!cancelling) finish(error);
						};
						const onError = (error: Error): void => onWritten(error);
						const onClose = (): void => onWritten(inputError ?? new Error("Command stdin is closed."));
						const onAbort = (): void => {
							if (finished || cancelling) return;
							cancelling = true;
							stop();
							void completion.then(() => finish(new Error("aborted")));
						};
						stdin.once("error", onError);
						stdin.once("close", onClose);
						signal?.addEventListener("abort", onAbort, { once: true });
						if (signal?.aborted) {
							onAbort();
							return;
						}
						try {
							if (close) inputClosed = true;
							if (close) stdin.end(text, "utf8", onWritten);
							else stdin.write(text, "utf8", onWritten);
						} catch (error) {
							onWritten(error instanceof Error ? error : new Error(String(error)));
						}
					});
				},
			};
		},
	};
}

const localBackgroundCommandOutputStore: BackgroundCommandOutputStore = {
	create(taskId) {
		const path = join(tmpdir(), `vetta-task-${taskId}-${randomBytes(4).toString("hex")}.log`);
		const writer = openSync(path, "wx", 0o600);
		let closed = false;
		return {
			path,
			append(text) {
				if (closed) throw new Error("Command output is closed.");
				// The synchronous output port must make every append visible before
				// the service advances its cursor or announces command completion.
				writeFileSync(writer, text);
			},
			read(offset, maxBytes) {
				const reader = openSync(path, "r");
				try {
					const remaining = Math.max(0, fstatSync(reader).size - offset);
					const bytes = Buffer.alloc(Math.min(remaining, maxBytes ?? remaining));
					const count = readSync(reader, bytes, 0, bytes.length, offset);
					// Do not consume an incomplete UTF-8 suffix: the service advances
					// its byte cursor by the returned text's encoded length.
					return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, count), {
						stream: count < remaining,
					});
				} finally {
					closeSync(reader);
				}
			},
			close() {
				if (closed) return;
				closed = true;
				closeSync(writer);
			},
		};
	},
};
