import { randomBytes } from "node:crypto";
import type {
	BackgroundCommandHost,
	BackgroundCommandOutput,
	BackgroundCommandProcess,
} from "./background-command-host.js";
import type {
	BackgroundCommandEvent,
	BackgroundCommandService,
	BackgroundCommandSnapshot,
	BackgroundCommandStatus,
	BackgroundCommandStopReason,
	ReadBackgroundCommandOutputOptions,
	SpawnBackgroundCommandOptions,
} from "./background-command-service.js";

interface BackgroundCommandTask {
	snapshot: BackgroundCommandSnapshot;
	process?: BackgroundCommandProcess;
	output: BackgroundCommandOutput;
	readOffset: number;
	writtenBytes: number;
	ended: boolean;
	stopping: boolean;
	outputFailure?: string;
	notified: boolean;
	promoted: boolean;
	notifyOnlyIfPromoted: boolean;
	interactive: boolean;
	inputClosed: boolean;
	inputTail: Promise<void>;
	pendingInputs: number;
	waiters: Array<() => void>;
	outputTimer?: ReturnType<typeof setTimeout>;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	stopReason?: BackgroundCommandStopReason;
}

const TAIL_MAX_CHARS = 2048;
const OUTPUT_EVENT_THROTTLE_MS = 200;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_INTERACTIVE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const INPUT_TIMEOUT_MS = 30_000;
const MAX_INTERACTIVE_TASKS = 8;

/** The session's sole process owner; input, output, cancellation and cleanup share the same task map. */
export function createBackgroundCommandService(host: BackgroundCommandHost): BackgroundCommandService {
	const tasks = new Map<string, BackgroundCommandTask>();
	const listeners: Array<(event: BackgroundCommandEvent) => void> = [];
	const notificationListeners: Array<(task: BackgroundCommandSnapshot) => void> = [];
	const sessionNonce = randomBytes(12).toString("hex");
	let counter = 0;
	let disposed = false;
	let shutdownPromise: Promise<void> | undefined;

	const notifyObservers = <T>(observers: Array<(value: T) => void>, value: T): void => {
		for (const observer of [...observers]) {
			try {
				observer(value);
			} catch (error) {
				console.warn("Background command observer failed.", error);
			}
		}
	};
	const emit = (event: BackgroundCommandEvent): void => notifyObservers(listeners, event);
	const scheduleOutputEvent = (task: BackgroundCommandTask): void => {
		if (task.outputTimer || task.ended) return;
		task.outputTimer = setTimeout(() => {
			task.outputTimer = undefined;
			if (!task.ended) emit({ type: "task_output", task: { ...task.snapshot } });
		}, OUTPUT_EVENT_THROTTLE_MS);
	};
	const finish = (
		task: BackgroundCommandTask,
		status: BackgroundCommandStatus,
		exitCode: number | undefined,
	): void => {
		if (task.ended) return;
		task.ended = true;
		clearTimeout(task.outputTimer);
		clearTimeout(task.timeoutTimer);
		task.outputTimer = undefined;
		task.timeoutTimer = undefined;
		try {
			task.output.close();
		} catch (error) {
			task.outputFailure ??= `Failed to close command output: ${error instanceof Error ? error.message : String(error)}`;
		}
		task.snapshot = {
			...task.snapshot,
			status: task.outputFailure ? "failed" : task.stopReason ? "killed" : status,
			exitCode,
			endedAt: Date.now(),
			...(task.stopReason ? { endedBy: task.stopReason } : {}),
			...(task.outputFailure ? { failureReason: task.outputFailure } : {}),
		};
		for (const waiter of task.waiters.splice(0)) waiter();
		emit({ type: "task_ended", task: { ...task.snapshot } });
		if ((!task.notifyOnlyIfPromoted || task.promoted) && !task.notified) {
			task.notified = true;
			notifyObservers(notificationListeners, { ...task.snapshot });
		}
	};
	const stop = (taskId: string, reason?: BackgroundCommandStopReason): boolean => {
		const task = tasks.get(taskId);
		if (!task || task.ended) return false;
		// The first stop owns the terminal reason; repeated stop requests are harmless.
		if (task.stopping) return true;
		task.stopping = true;
		task.stopReason = reason ?? "caller";
		task.process?.stop();
		return true;
	};
	const appendOutput = (task: BackgroundCommandTask, text: string): void => {
		if (!text || task.ended || task.outputFailure || task.stopReason === "output-limit") return;
		const bytes = Buffer.byteLength(text, "utf-8");
		const overLimit = task.interactive && task.writtenBytes + bytes > MAX_INTERACTIVE_OUTPUT_BYTES;
		if (overLimit) {
			stop(task.snapshot.id, "output-limit");
			return;
		}
		try {
			task.output.append(text);
		} catch (error) {
			task.outputFailure = `Failed to store command output: ${error instanceof Error ? error.message : String(error)}`;
			task.snapshot = { ...task.snapshot, failureReason: task.outputFailure };
			if (!task.stopping) {
				task.stopping = true;
				task.process?.stop();
			}
			return;
		}
		task.writtenBytes += bytes;
		task.snapshot = { ...task.snapshot, tail: (task.snapshot.tail + text).slice(-TAIL_MAX_CHARS) };
		scheduleOutputEvent(task);
	};
	const awaitEnd = (task: BackgroundCommandTask): Promise<void> =>
		task.ended ? Promise.resolve() : new Promise((resolve) => task.waiters.push(resolve));

	return {
		supportsInteractiveInput: host.processOperations.supportsInteractiveInput === true,
		spawn(options: SpawnBackgroundCommandOptions): BackgroundCommandSnapshot {
			if (disposed || shutdownPromise) throw new Error("Background command service is closed or quiescing.");
			if (options.interactive && !host.processOperations.supportsInteractiveInput) {
				throw new Error("Interactive pipe input is not supported by this host.");
			}
			if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
				throw new Error("Command timeout must be a positive finite number.");
			}
			if (
				options.interactive &&
				[...tasks.values()].filter((task) => task.interactive && !task.ended).length >= MAX_INTERACTIVE_TASKS
			) {
				throw new Error(`At most ${MAX_INTERACTIVE_TASKS} interactive commands may run in one session.`);
			}
			// An old conversation's interactive ID must never address a newly spawned process.
			const id = `b${++counter}${options.interactive ? `-${sessionNonce}` : ""}`;
			const output = host.outputStore.create(id);
			const task: BackgroundCommandTask = {
				snapshot: {
					id,
					command: options.command,
					cwd: options.cwd,
					status: "running",
					outputFile: output.path,
					exitCode: undefined,
					startedAt: Date.now(),
					toolCallId: options.toolCallId,
					tail: "",
				},
				output,
				readOffset: 0,
				writtenBytes: 0,
				ended: false,
				stopping: false,
				notified: false,
				promoted: false,
				notifyOnlyIfPromoted: options.notifyOnlyIfPromoted ?? false,
				interactive: options.interactive === true,
				inputClosed: false,
				inputTail: Promise.resolve(),
				pendingInputs: 0,
				waiters: [],
			};
			tasks.set(id, task);
			emit({ type: "task_started", task: { ...task.snapshot } });
			if (disposed || task.stopping) {
				finish(task, "killed", undefined);
				return { ...task.snapshot };
			}
			try {
				task.process = host.processOperations.spawn({
					command: options.command,
					cwd: options.cwd,
					env: options.env,
					interactive: options.interactive,
					onOutput: (text) => appendOutput(task, text),
					onExit: (exitCode) =>
						finish(task, exitCode === undefined ? "killed" : exitCode === 0 ? "completed" : "failed", exitCode),
					onError: (error) => {
						appendOutput(task, `\nFailed to spawn command: ${error.message}\n`);
						finish(task, "failed", undefined);
					},
				});
				if (task.stopping && !task.ended) task.process.stop();
				if (options.timeoutMs !== undefined && !task.ended) {
					task.timeoutTimer = setTimeout(() => stop(id, "timeout"), options.timeoutMs);
				}
			} catch (error) {
				finish(task, "failed", undefined);
				throw error;
			}
			return { ...task.snapshot };
		},
		async writeInput(taskId, options) {
			options.signal?.throwIfAborted();
			if (disposed || shutdownPromise) throw new Error("Background command service is closed or quiescing.");
			const task = tasks.get(taskId);
			if (!task) throw new Error(`Background task "${taskId}" not found.`);
			if (!task.interactive || !task.process?.writeInput)
				throw new Error("Task does not support interactive input.");
			if (Buffer.byteLength(options.text, "utf-8") > MAX_INPUT_BYTES) throw new Error("Input exceeds 64 KiB.");
			if (task.pendingInputs >= 16) throw new Error("Too many pending task input writes.");
			task.pendingInputs += 1;
			const operation = task.inputTail.then(async () => {
				options.signal?.throwIfAborted();
				if (task.inputClosed && options.close && !options.text) return;
				if (disposed || task.ended || task.stopping || task.inputClosed) throw new Error("Task stdin is closed.");
				const controller = new AbortController();
				const onAbort = () => {
					stop(taskId, "caller");
					controller.abort(options.signal?.reason);
				};
				options.signal?.addEventListener("abort", onAbort, { once: true });
				const timer = setTimeout(() => {
					stop(taskId, "timeout");
					controller.abort(new Error("Task input timed out after 30 seconds."));
				}, INPUT_TIMEOUT_MS);
				try {
					await task.process!.writeInput!(options.text, options.close === true, controller.signal);
					if (options.close) task.inputClosed = true;
				} catch (error) {
					if (controller.signal.aborted) {
						stop(taskId, options.signal?.aborted ? "caller" : "timeout");
						await awaitEnd(task);
					}
					throw error;
				} finally {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				}
			});
			task.inputTail = operation
				.catch(() => {})
				.finally(() => {
					task.pendingInputs -= 1;
				});
			return operation;
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		subscribeNotifications(listener) {
			notificationListeners.push(listener);
			return () => {
				const index = notificationListeners.indexOf(listener);
				if (index >= 0) notificationListeners.splice(index, 1);
			};
		},
		async wait(taskId, options) {
			const task = tasks.get(taskId);
			if (!task) throw new Error(`Background task "${taskId}" not found.`);
			if (options.signal?.aborted) {
				stop(taskId, "caller");
				await awaitEnd(task);
				throw new Error("aborted");
			}
			if (task.ended) return { stillRunning: false, snapshot: { ...task.snapshot } };
			return new Promise((resolve, reject) => {
				let settled = false;
				let aborted = false;
				let timer: ReturnType<typeof setTimeout>;
				const cleanup = (): void => {
					options.signal?.removeEventListener("abort", onAbort);
					clearTimeout(timer);
					const index = task.waiters.indexOf(onEnd);
					if (index >= 0) task.waiters.splice(index, 1);
				};
				const settle = (stillRunning: boolean): void => {
					if (settled) return;
					settled = true;
					cleanup();
					if (aborted) reject(new Error("aborted"));
					else {
						if (stillRunning) task.promoted = true;
						resolve({ stillRunning, snapshot: { ...task.snapshot } });
					}
				};
				const onEnd = (): void => settle(false);
				const onAbort = (): void => {
					aborted = true;
					clearTimeout(timer);
					stop(taskId, "caller");
					if (task.ended) settle(false);
				};
				timer = setTimeout(() => settle(true), Math.max(0, options.maxMs));
				task.waiters.push(onEnd);
				options.signal?.addEventListener("abort", onAbort, { once: true });
				if (task.ended) settle(false);
				else if (options.signal?.aborted) onAbort();
			});
		},
		get(taskId) {
			const task = tasks.get(taskId);
			return task ? { ...task.snapshot } : undefined;
		},
		list: () => [...tasks.values()].map((task) => ({ ...task.snapshot })),
		clearFinished() {
			let cleared = 0;
			for (const [taskId, task] of tasks) {
				if (!task.ended || task.pendingInputs) continue;
				tasks.delete(taskId);
				cleared += 1;
			}
			if (cleared > 0) emit({ type: "tasks_cleared" });
			return cleared;
		},
		readOutput(taskId: string, options: ReadBackgroundCommandOutputOptions): string {
			const task = tasks.get(taskId);
			if (!task) return "";
			const start = options.fromStart ? 0 : task.readOffset;
			const maxBytes =
				options.maxBytes === undefined && !task.interactive
					? undefined
					: Math.max(4, Math.min(MAX_READ_BYTES, options.maxBytes ?? MAX_READ_BYTES));
			try {
				const text = task.output.read(start, maxBytes);
				if (options.advanceCursor) task.readOffset = start + Buffer.byteLength(text, "utf-8");
				return text;
			} catch {
				return "";
			}
		},
		stop,
		dispose() {
			disposed = true;
			for (const id of tasks.keys()) stop(id, "dispose");
		},
		async shutdown() {
			if (shutdownPromise) return shutdownPromise;
			const active = [...tasks.values()];
			// Quiescing is reversible; dispose is the permanent admission fence.
			shutdownPromise = Promise.resolve().then(async () => {
				for (const task of active) stop(task.snapshot.id, "dispose");
				await Promise.all(
					active.map(async (task) => {
						await awaitEnd(task);
						await task.inputTail;
					}),
				);
			});
			try {
				await shutdownPromise;
			} finally {
				shutdownPromise = undefined;
			}
		},
	};
}
