import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundCommandOutputStore,
	type BackgroundCommandProcessOperations,
	createBackgroundCommandService,
	createBackgroundCommandToolExecutor,
	type SpawnBackgroundCommandProcessOptions,
} from "../../../src/coding/index.js";

function fixture(
	options: {
		deferStop?: boolean;
		supportInput?: boolean;
		spawn?: (request: SpawnBackgroundCommandProcessOptions) => void;
	} = {},
) {
	const processes: SpawnBackgroundCommandProcessOptions[] = [];
	const writes: string[] = [];
	const stopped: string[] = [];
	const closed: string[] = [];
	const outputStore: BackgroundCommandOutputStore = {
		create(id) {
			let output = Buffer.alloc(0);
			return {
				path: `memory:${id}`,
				append: (text) => {
					output = Buffer.concat([output, Buffer.from(text)]);
				},
				read: (offset, maxBytes) =>
					output.subarray(offset, maxBytes === undefined ? undefined : offset + maxBytes).toString(),
				close: () => {
					closed.push(id);
				},
			};
		},
	};
	const processOperations: BackgroundCommandProcessOperations = {
		supportsInteractiveInput: options.supportInput !== false,
		spawn(request) {
			processes.push(request);
			options.spawn?.(request);
			return {
				stop() {
					stopped.push(request.command);
					if (!options.deferStop) request.onExit(undefined);
				},
				async writeInput(text, close) {
					writes.push(text);
					if (text) request.onOutput(`echo:${text}`);
					if (close) request.onExit(0);
				},
			};
		},
	};
	const service = createBackgroundCommandService({ processOperations, outputStore });
	const start = (command = "interactive", timeoutMs?: number) =>
		service.spawn({ command, cwd: "/isolated", env: {}, interactive: true, timeoutMs });
	return { service, start, processes, writes, stopped, closed };
}

afterEach(() => vi.useRealTimers());

describe("interactive command ownership", () => {
	it("continues one pipe across calls, reads bounded chunks, closes stdin idempotently and rejects later text", async () => {
		const { service, start, writes } = fixture();
		try {
			const task = start();
			await service.writeInput!(task.id, { text: "first" });
			expect(service.readOutput(task.id, { fromStart: false, advanceCursor: true, maxBytes: 5 })).toBe("echo:");
			expect(service.readOutput(task.id, { fromStart: false, advanceCursor: true })).toBe("first");
			await service.writeInput!(task.id, { text: "second", close: true });
			await service.writeInput!(task.id, { text: "", close: true });
			expect(writes).toEqual(["first", "second"]);
			expect(service.get(task.id)).toMatchObject({ status: "completed", exitCode: 0 });
			await expect(service.writeInput!(task.id, { text: "late" })).rejects.toThrow("closed");
		} finally {
			service.dispose();
			await service.shutdown();
		}
	});

	it("rejects stale task IDs across owners and input on non-interactive tasks", async () => {
		const first = fixture();
		const second = fixture();
		try {
			const task = first.start();
			const other = second.start();
			expect(task.id).not.toBe(other.id);
			await expect(second.service.writeInput!(task.id, { text: "unsafe" })).rejects.toThrow("not found");
			const ordinary = second.service.spawn({ command: "ordinary", cwd: "/isolated", env: {} });
			await expect(second.service.writeInput!(ordinary.id, { text: "unsafe" })).rejects.toThrow("does not support");
			expect(second.writes).toEqual([]);
		} finally {
			first.service.dispose();
			second.service.dispose();
			await Promise.all([first.service.shutdown(), second.service.shutdown()]);
		}
	});

	it("rejects unsupported input, invalid timeouts and oversized writes before effects", async () => {
		const unsupported = fixture({ supportInput: false });
		expect(() => unsupported.start()).toThrow("not supported");
		expect(unsupported.processes).toEqual([]);
		const current = fixture();
		try {
			for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
				expect(() => current.start("invalid", timeout)).toThrow("positive finite");
			const task = current.start();
			await expect(current.service.writeInput!(task.id, { text: "a".repeat(65537) })).rejects.toThrow("64 KiB");
			const controller = new AbortController();
			controller.abort();
			await expect(
				current.service.writeInput!(task.id, { text: "unsafe", signal: controller.signal }),
			).rejects.toThrow();
			expect(current.writes).toEqual([]);
		} finally {
			current.service.dispose();
			await current.service.shutdown();
		}
	});

	it("does not settle cancellation or shutdown until process exit and permanently fences dispose only", async () => {
		const current = fixture({ deferStop: true });
		const task = current.start();
		const controller = new AbortController();
		let settled = false;
		const waiting = current.service
			.wait(task.id, { maxMs: 10000, signal: controller.signal })
			.catch((error: Error) => {
				settled = true;
				return error;
			});
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(current.stopped).toEqual(["interactive"]);
		current.processes[0].onExit(undefined);
		expect(await waiting).toMatchObject({ message: "aborted" });
		await current.service.shutdown();
		const next = current.start("next");
		current.service.dispose();
		current.service.dispose();
		expect(current.stopped).toEqual(["interactive", "next"]);
		expect(() => current.start("late")).toThrow("closed");
		let closed = false;
		const shutdown = current.service.shutdown().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		current.processes[1].onExit(undefined);
		await shutdown;
		expect(current.service.get(next.id)?.endedBy).toBe("dispose");
	});

	it("waits for confirmed process exit after a backpressured input timeout", async () => {
		vi.useFakeTimers();
		let request!: SpawnBackgroundCommandProcessOptions;
		let beginInput!: () => void;
		const started = new Promise<void>((resolve) => {
			beginInput = resolve;
		});
		const stops: string[] = [];
		const service = createBackgroundCommandService({
			outputStore: { create: () => ({ path: "memory:timeout", append() {}, read: () => "", close() {} }) },
			processOperations: {
				supportsInteractiveInput: true,
				spawn: (options) => {
					request = options;
					return {
						stop: () => {
							stops.push("stop");
						},
						writeInput: (_text, _close, signal) =>
							new Promise((_resolve, reject) => {
								beginInput();
								signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							}),
					};
				},
			},
		});
		const task = service.spawn({ command: "blocked", cwd: "/isolated", env: {}, interactive: true });
		let settled = false;
		const writing = service.writeInput!(task.id, { text: "pending" }).catch((error: Error) => {
			settled = true;
			return error;
		});
		await started;
		await vi.advanceTimersByTimeAsync(30000);
		expect(stops).toEqual(["stop"]);
		expect(settled).toBe(false);
		request.onExit(undefined);
		expect(await writing).toMatchObject({ message: "aborted" });
		expect(service.get(task.id)).toMatchObject({ status: "killed", endedBy: "timeout" });
		service.dispose();
		await service.shutdown();
	});

	it("preserves synchronous spawn completion and rolls back output on synchronous failure", async () => {
		const immediate = fixture({
			spawn: (request) => {
				request.onOutput("ready");
				request.onExit(0);
			},
		});
		const task = immediate.start();
		expect(task.status).toBe("completed");
		expect(immediate.service.readOutput(task.id, { fromStart: true, advanceCursor: false })).toBe("ready");
		expect(immediate.closed).toEqual([task.id]);
		const failed = fixture({
			spawn: () => {
				throw new Error("spawn failed");
			},
		});
		expect(() => failed.start()).toThrow("spawn failed");
		expect(failed.service.list()[0].status).toBe("failed");
		expect(failed.closed).toHaveLength(1);
		immediate.service.dispose();
		failed.service.dispose();
		await Promise.all([immediate.service.shutdown(), failed.service.shutdown()]);
	});

	it.each(["append", "close"] as const)(
		"settles output %s failures without losing process ownership or terminal delivery",
		async (failure) => {
			let process!: SpawnBackgroundCommandProcessOptions;
			let stops = 0;
			let closes = 0;
			const events: string[] = [];
			const service = createBackgroundCommandService({
				outputStore: {
					create: () => ({
						path: "memory:fault",
						append: () => {
							if (failure === "append") throw new Error("ENOSPC");
						},
						read: () => "",
						close: () => {
							closes += 1;
							if (failure === "close") throw new Error("EBADF");
						},
					}),
				},
				processOperations: {
					supportsInteractiveInput: true,
					spawn: (request) => {
						process = request;
						return {
							stop: () => {
								stops += 1;
							},
						};
					},
				},
			});
			service.subscribe((event) => events.push(event.type));
			const task = service.spawn({ command: "output-failure", cwd: "/isolated", env: {}, interactive: true });
			let settled = false;
			const completion = service.wait(task.id, { maxMs: 10000 }).then((result) => {
				settled = true;
				return result;
			});
			expect(() => process.onOutput("chunk")).not.toThrow();
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(stops).toBe(failure === "append" ? 1 : 0);
			expect(() => process.onExit(0)).not.toThrow();
			expect(await completion).toMatchObject({
				stillRunning: false,
				snapshot: {
					status: "failed",
					failureReason: expect.stringContaining(failure === "append" ? "ENOSPC" : "EBADF"),
				},
			});
			expect(events).toEqual(["task_started", "task_ended"]);
			expect(closes).toBe(1);
			service.dispose();
			await service.shutdown();
		},
	);

	it("reports output finalization failure through the ordinary command executor even with exit code zero", async () => {
		const service = createBackgroundCommandService({
			outputStore: {
				create: () => ({
					path: "memory:close-failure",
					append() {},
					read: () => "command succeeded",
					close: () => {
						throw new Error("close failed");
					},
				}),
			},
			processOperations: {
				spawn: (request) => {
					request.onExit(0);
					return { stop() {} };
				},
			},
		});
		const executor = createBackgroundCommandToolExecutor({
			backgroundService: service,
			foregroundExecutor: {
				execute: async () => {
					throw new Error("Unexpected foreground fallback");
				},
			},
			environment: () => ({}),
		});
		try {
			await expect(
				executor.execute({
					toolName: "bash",
					cwd: process.cwd(),
					toolCallId: "output-close",
					input: { command: "echo ok" },
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("Failed to close command output: close failed");
		} finally {
			service.dispose();
			await service.shutdown();
		}
	});

	it("does not spawn a process after disposal by a start observer", async () => {
		const current = fixture();
		current.service.subscribe((event) => {
			if (event.type === "task_started") current.service.dispose();
		});
		const task = current.start();
		expect(current.processes).toEqual([]);
		expect(task).toMatchObject({ status: "killed", endedBy: "dispose" });
		expect(current.closed).toEqual([task.id]);
		await current.service.shutdown();
	});

	it("enforces hard timeout, active-session count and bounded output without retaining an overflowing chunk", async () => {
		vi.useFakeTimers();
		const current = fixture();
		try {
			const timed = current.start("timed", 100);
			await vi.advanceTimersByTimeAsync(100);
			expect(current.service.get(timed.id)).toMatchObject({ status: "killed", endedBy: "timeout" });
			const noisy = current.start("noisy");
			current.processes[1].onOutput("x".repeat(16 * 1024 * 1024 + 1));
			expect(current.service.get(noisy.id)).toMatchObject({ status: "killed", endedBy: "output-limit", tail: "" });
			for (let index = 0; index < 8; index++) current.start(`open-${index}`);
			expect(() => current.start("overflow")).toThrow("At most 8");
		} finally {
			current.service.dispose();
			await current.service.shutdown();
		}
	});
});
