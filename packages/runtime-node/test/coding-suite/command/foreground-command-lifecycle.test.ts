import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeForegroundCommandHost } from "../../../src/coding/host/local-command-host.js";
import { killNodeProcessTree } from "../../../src/coding/host/process-tree.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../../src/coding/host/process-tree.js", () => ({ killNodeProcessTree: vi.fn() }));

class ControlledChildProcess extends EventEmitter {
	pid: number | undefined = 987654;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn();
}

let child: ControlledChildProcess;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	child = new ControlledChildProcess();
	vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});

afterEach(() => {
	child.stdout.destroy();
	child.stderr.destroy();
	vi.useRealTimers();
});

function execute(signal?: AbortSignal, timeout?: number) {
	return createNodeForegroundCommandHost({
		resolveShell: () => ({ executable: process.execPath, args: ["-e"] }),
	}).operations.exec("controlled-command", process.cwd(), {
		onData: () => {},
		signal,
		timeout,
		env: {},
	});
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("foreground command cancellation ownership", () => {
	it("rejects pre-cancelled commands without spawning a process", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(execute(controller.signal)).rejects.toThrow("aborted");
		expect(spawn).not.toHaveBeenCalled();
		expect(killNodeProcessTree).not.toHaveBeenCalled();
	});

	it.each(["abort", "timeout"] as const)(
		"retains process ownership after %s until close is confirmed",
		async (reason) => {
			const controller = new AbortController();
			const execution = execute(controller.signal, 1);
			const settled = vi.fn();
			void execution.then(settled, settled);
			if (reason === "abort") controller.abort();
			else vi.advanceTimersByTime(1_000);
			expect(killNodeProcessTree).toHaveBeenCalledWith(child.pid);
			child.emit("exit", null);
			await nextTurn();
			expect(settled).not.toHaveBeenCalled();
			expect(child.stdout.destroyed).toBe(false);

			child.emit("close", null);
			await expect(execution).rejects.toThrow(reason === "abort" ? "aborted" : "timeout:1");
			expect(child.stdout.destroyed).toBe(true);
			expect(child.stderr.destroyed).toBe(true);
		},
	);

	it.each(["abort", "timeout"] as const)("does not let an already queued exit callback outrun %s", async (reason) => {
		const controller = new AbortController();
		const execution = execute(controller.signal, 1);
		const settled = vi.fn();
		void execution.then(settled, settled);
		child.emit("exit", 0);
		if (reason === "abort") controller.abort();
		else vi.advanceTimersByTime(1_000);
		await nextTurn();
		expect(settled).not.toHaveBeenCalled();

		child.emit("close", 0);
		await expect(execution).rejects.toThrow(reason === "abort" ? "aborted" : "timeout:1");
	});

	it("preserves the first stop reason while later cancellation is waiting for close", async () => {
		const controller = new AbortController();
		const execution = execute(controller.signal, 1);
		const settled = vi.fn();
		void execution.then(settled, settled);
		vi.advanceTimersByTime(1_000);
		controller.abort();
		await nextTurn();
		expect(settled).not.toHaveBeenCalled();
		child.emit("close", null);
		await expect(execution).rejects.toThrow("timeout:1");
	});

	it("reports a spawn failure without waiting for close when no process was created", async () => {
		child.pid = undefined;
		const execution = execute();
		const rejected = expect(execution).rejects.toThrow("spawn unavailable");
		child.emit("error", new Error("spawn unavailable"));
		await rejected;
	});

	it("can finish cancellation on a confirmed spawn failure with no process to own", async () => {
		child.pid = undefined;
		const controller = new AbortController();
		const execution = execute(controller.signal);
		const rejected = expect(execution).rejects.toThrow("aborted");
		controller.abort();
		child.emit("error", new Error("spawn unavailable"));
		await rejected;
	});

	it("does not treat an error from a live cancelled process as confirmation of close", async () => {
		const controller = new AbortController();
		const execution = execute(controller.signal);
		const settled = vi.fn();
		void execution.then(settled, settled);
		controller.abort();
		child.emit("error", new Error("kill could not be confirmed"));
		await nextTurn();
		expect(settled).not.toHaveBeenCalled();
		child.emit("close", null);
		await expect(execution).rejects.toThrow("aborted");
	});

	it("retains the successful daemon exit fast path when no cancellation is pending", async () => {
		const execution = execute();
		child.emit("exit", 0);
		await expect(execution).resolves.toEqual({ exitCode: 0 });
		expect(killNodeProcessTree).not.toHaveBeenCalled();
	});
});
