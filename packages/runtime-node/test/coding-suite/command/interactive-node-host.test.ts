import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeBackgroundCommandHost,
	createNodeForegroundCommandHost,
} from "../../../src/coding/host/local-command-host.js";
import type {
	BackgroundCommandOutput,
	BackgroundCommandProcess,
} from "../../../src/coding/shared/background-command-host.js";

const cleanups: Array<() => Promise<void>> = [];
const nodeShell = () => ({ executable: process.execPath, args: ["-e"] });

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function startCommand(command: string, interactive = true) {
	const cwd = mkdtempSync(join(tmpdir(), "vetta-interactive-host-"));
	const host = createNodeBackgroundCommandHost({ resolveShell: nodeShell });
	const output = host.outputStore.create("interactive-test");
	let text = "";
	let ended = false;
	let failure: Error | undefined;
	let exitCode: number | undefined;
	let finish!: () => void;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const outputListeners = new Set<() => void>();
	const onEnd = () => {
		ended = true;
		output.close();
		for (const listener of outputListeners) listener();
		finish();
	};
	const child = host.processOperations.spawn({
		command,
		cwd,
		interactive,
		env: {
			HOME: cwd,
			USERPROFILE: cwd,
			TMPDIR: cwd,
			TMP: cwd,
			TEMP: cwd,
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		},
		onOutput: (chunk) => {
			text += chunk;
			output.append(chunk);
			for (const listener of outputListeners) listener();
		},
		onExit: (code) => {
			exitCode = code;
			onEnd();
		},
		onError: (error) => {
			failure = error;
			onEnd();
		},
	});
	cleanups.push(async () => {
		if (!ended) child.stop();
		await completion;
		rmSync(output.path, { force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		child,
		output,
		completion,
		get ended() {
			return ended;
		},
		get failure() {
			return failure;
		},
		get exitCode() {
			return exitCode;
		},
		get text() {
			return text;
		},
		waitForOutput(expected: string): Promise<void> {
			return new Promise((resolve, reject) => {
				const check = () => {
					if (!text.includes(expected) && !ended) return;
					outputListeners.delete(check);
					if (text.includes(expected)) resolve();
					else reject(failure ?? new Error(`Command ended before output: ${expected}`));
				};
				outputListeners.add(check);
				check();
			});
		},
	};
}

function writeInput(child: BackgroundCommandProcess, text: string, close = false, signal?: AbortSignal) {
	if (!child.writeInput) throw new Error("Node command host does not expose stdin writes.");
	return child.writeInput(text, close, signal);
}

function createOutput(): BackgroundCommandOutput {
	const output = createNodeBackgroundCommandHost({ resolveShell: nodeShell }).outputStore.create("output-test");
	cleanups.push(async () => {
		output.close();
		rmSync(output.path, { force: true });
	});
	return output;
}

function isProcessRunning(pid: number): boolean {
	try {
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return state.length > 0 && !state.startsWith("Z");
	} catch (error) {
		if (error !== null && typeof error === "object" && "status" in error && error.status === 1) return false;
		throw error;
	}
}

describe("Node interactive command capability", () => {
	it("only advertises interactive input where process-group ownership is supported", () => {
		expect(
			createNodeBackgroundCommandHost({ resolveShell: nodeShell }).processOperations.supportsInteractiveInput,
		).toBe(process.platform !== "win32");
	});

	it("rejects an interactive spawn on Windows before launching a process", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platform) throw new Error("Node process.platform descriptor is unavailable.");
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			const host = createNodeBackgroundCommandHost({
				resolveShell: () => {
					throw new Error("An unsupported platform must not reach shell resolution.");
				},
			});
			expect(host.processOperations.supportsInteractiveInput).toBe(false);
			expect(() =>
				host.processOperations.spawn({
					command: "process.stdout.write('must-not-spawn')",
					cwd: "/unused",
					env: {},
					interactive: true,
					onOutput: () => {},
					onExit: () => {},
					onError: () => {},
				}),
			).toThrow("Interactive command input is not supported on Windows.");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});
});

describe.skipIf(process.platform === "win32")("Node interactive command host", () => {
	it("continues one pipe process across input writes, closes stdin, and exposes final output immediately", async () => {
		const running = startCommand(
			[
				"process.stdout.write('pipe:' + Boolean(process.stdin.isTTY) + '\\n')",
				"process.stdin.setEncoding('utf8')",
				"process.stdin.on('data', text => process.stdout.write('input:' + text))",
				"process.stdin.on('end', () => process.stdout.write('eof\\n'))",
			].join(";"),
		);

		await running.waitForOutput("pipe:false\n");
		await writeInput(running.child, "first\n");
		await running.waitForOutput("input:first\n");
		expect(running.ended).toBe(false);
		await writeInput(running.child, "第二次\n", true);
		await running.completion;

		expect(running.failure).toBeUndefined();
		expect(running.exitCode).toBe(0);
		expect(running.text).toBe("pipe:false\ninput:first\ninput:第二次\neof\n");
		expect(running.output.read(0)).toBe(running.text);
		await expect(writeInput(running.child, "late")).rejects.toThrow(/exited/);
	});

	it("keeps noninteractive stdin ignored and rejects input rather than pretending to be interactive", async () => {
		const running = startCommand(
			"process.stdin.on('end', () => process.stdout.write('eof'));process.stdin.resume()",
			false,
		);
		await expect(writeInput(running.child, "input")).rejects.toThrow(/not enabled/);
		await running.completion;
		expect(running.text).toBe("eof");
		expect(running.exitCode).toBe(0);
	});

	it("rejects a second write once EOF has been requested even while the child is still running", async () => {
		const running = startCommand(
			"process.stdin.resume();process.stdin.on('end', () => process.stdout.write('eof'));setInterval(() => {}, 1000)",
		);
		const close = writeInput(running.child, "", true);
		await expect(writeInput(running.child, "after-eof")).rejects.toThrow(/stdin is closed/);
		await close;
		await running.waitForOutput("eof");
		expect(running.ended).toBe(false);
	});

	it("kills a blocked input writer and confirms process exit before reporting cancellation", async () => {
		const running = startCommand("process.stdout.write('pid:' + process.pid + '\\n');setInterval(() => {}, 1000)");
		await running.waitForOutput("\n");
		const pid = Number(running.text.trim().slice("pid:".length));
		const controller = new AbortController();
		const writing = writeInput(running.child, "x".repeat(16 * 1024 * 1024), false, controller.signal);
		const cancelled = expect(writing).rejects.toThrow("aborted");
		controller.abort();
		await cancelled;

		expect(running.ended).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(writeInput(running.child, "late")).rejects.toThrow(/exited/);
	});

	it("does not deliver input with an already aborted signal and waits for the child to exit", async () => {
		const running = startCommand(
			"process.stdin.on('data', () => process.stdout.write('unexpected-input'));process.stdout.write('ready')",
		);
		await running.waitForOutput("ready");
		const controller = new AbortController();
		controller.abort();
		await expect(writeInput(running.child, "cancelled", true, controller.signal)).rejects.toThrow("aborted");
		expect(running.ended).toBe(true);
		expect(running.text).toBe("ready");
	});

	it("flushes a large final input before EOF and retains the complete final output", async () => {
		const running = startCommand(
			"process.stdin.pipe(process.stdout);process.stdin.on('end', () => process.stdout.write('final'))",
		);
		const input = "输入".repeat(128 * 1024);
		await writeInput(running.child, input, true);
		await running.completion;
		expect(running.exitCode).toBe(0);
		expect(running.output.read(0)).toBe(`${input}final`);
	});

	it("decodes stdout and stderr independently while input advances a multibyte response", async () => {
		const running = startCommand(
			[
				"process.stdout.write(Buffer.concat([Buffer.from('ready'), Buffer.from([0xe4])]))",
				"process.stdin.once('data', () => { process.stderr.write('warning'); process.stdin.once('data', () => process.stdout.write(Buffer.from([0xbd, 0xa0]))) })",
			].join(";"),
		);
		await running.waitForOutput("ready");
		await writeInput(running.child, "stderr");
		await running.waitForOutput("warning");
		await writeInput(running.child, "finish", true);
		await running.completion;
		expect(running.text).toBe("readywarning你");
	});

	it("flushes an incomplete output character when the pipe ends", async () => {
		const running = startCommand("process.stdout.write(Buffer.from([0xe4]))");
		await running.completion;
		expect(running.output.read(0)).toBe("\uFFFD");
	});

	it("terminates child and grandchild processes before releasing an exited interactive leader", async () => {
		const grandchildScript = "process.send({ grandchild: process.pid });setInterval(() => {}, 1000)";
		const childScript = [
			"const { spawn } = require('node:child_process')",
			`const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
			"grandchild.on('message', message => process.send({ ...message, child: process.pid }))",
			"setInterval(() => {}, 1000)",
		].join(";");
		const running = startCommand(
			[
				"const { spawn } = require('node:child_process')",
				`const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
				"child.on('message', message => { process.stdin.once('data', () => process.exit(0)); process.stdout.write(JSON.stringify({ ...message, leader: process.pid }) + '\\n') })",
			].join(";"),
		);
		await running.waitForOutput("\n");
		const pids = JSON.parse(running.text) as { leader: number; child: number; grandchild: number };
		try {
			expect(isProcessRunning(pids.child)).toBe(true);
			expect(isProcessRunning(pids.grandchild)).toBe(true);
			await writeInput(running.child, "exit");
			await running.completion;
			expect(running.exitCode).toBe(0);
			expect(isProcessRunning(pids.child)).toBe(false);
			expect(isProcessRunning(pids.grandchild)).toBe(false);
		} finally {
			try {
				process.kill(-pids.leader, "SIGKILL");
			} catch {
				// The host normally already terminated every process in this group.
			}
		}
	});

	it("rejects broken-pipe input without an unhandled stream error or losing process ownership", async () => {
		const running = startCommand(
			"require('node:fs').closeSync(0);process.stdout.write('stdin-closed');setInterval(() => {}, 1000)",
		);
		await running.waitForOutput("stdin-closed");
		await expect(writeInput(running.child, "input")).rejects.toThrow(/EPIPE|stdin is closed/);
		await expect(writeInput(running.child, "retry")).rejects.toThrow(/EPIPE|stdin is closed/);
		expect(running.ended).toBe(false);
		running.child.stop();
		await running.completion;
		expect(running.ended).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("Node foreground command host cancellation", () => {
	it("confirms real process closure before returning cancellation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "vetta-foreground-cancel-"));
		const controller = new AbortController();
		let reportReady!: (pid: number) => void;
		const ready = new Promise<number>((resolve) => {
			reportReady = resolve;
		});
		let output = "";
		const execution = createNodeForegroundCommandHost({ resolveShell: nodeShell }).operations.exec(
			"process.stdout.write('pid:' + process.pid + '\\n');setInterval(() => {}, 1000)",
			cwd,
			{
				onData: (data) => {
					output += Buffer.from(data).toString("utf8");
					const match = /pid:(\d+)\n/.exec(output);
					if (match) reportReady(Number(match[1]));
				},
				env: { HOME: cwd, TMPDIR: cwd },
				signal: controller.signal,
			},
		);
		cleanups.push(async () => {
			controller.abort();
			await execution.catch(() => undefined);
			rmSync(cwd, { recursive: true, force: true });
		});
		const pid = await Promise.race([
			ready,
			execution.then(() => {
				throw new Error("Command exited before reporting its process ID.");
			}),
		]);
		controller.abort();
		await expect(execution).rejects.toThrow("aborted");
		expect(isProcessRunning(pid)).toBe(false);
	});
});

describe("Node background output storage", () => {
	it("makes appended output readable synchronously, retains closed logs, and rejects writes after close", () => {
		const output = createOutput();
		expect(output.read(0)).toBe("");
		output.append("first");
		expect(output.read(0)).toBe("first");
		output.append("-last");
		output.close();
		output.close();
		expect(output.read(5)).toBe("-last");
		expect(readFileSync(output.path, "utf8")).toBe("first-last");
		expect(() => output.append("late")).toThrow(/closed/);
	});

	it("reads a bounded byte range without corrupting a multibyte character at the limit", () => {
		const output = createOutput();
		output.append("a你好z");
		expect(output.read(0, 3)).toBe("a");
		expect(output.read(1, 4)).toBe("你");
		expect(output.read(4, 4)).toBe("好z");
		expect(output.read(8, 4)).toBe("");
		expect(output.read(0, 0)).toBe("");
	});

	it("preserves an encoded byte-order mark so callers can advance the output cursor correctly", () => {
		const output = createOutput();
		output.append("\uFEFFtext");
		expect(output.read(0, 4)).toBe("\uFEFFt");
		expect(output.read(4)).toBe("ext");
	});
});
