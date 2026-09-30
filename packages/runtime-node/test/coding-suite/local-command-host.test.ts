import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import {
	createNodeBackgroundCommandHost,
	createNodeForegroundCommandHost,
	killNodeProcessTree,
} from "../../src/coding/host/index.js";
import { createBackgroundCommandService } from "../../src/coding/shared/background-command-lifecycle.js";

const nodeShell = () => ({ executable: process.execPath, args: ["-e"] });

describe("Node local command host", () => {
	it("executes a foreground command through the injected shell", async () => {
		const host = createNodeForegroundCommandHost({ resolveShell: nodeShell });
		let output = "";
		const result = await host.operations.exec("process.stdout.write('foreground-ok')", process.cwd(), {
			onData: (data) => {
				output += Buffer.from(data).toString("utf8");
			},
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		expect(output).toBe("foreground-ok");
	});

	it("settles when a daemon keeps inherited output pipes open after the command shell exits", async () => {
		const host = createNodeForegroundCommandHost({ resolveShell: nodeShell });
		const startedAt = Date.now();
		const result = await host.operations.exec(createDaemonCommand(), process.cwd(), {
			onData: () => {},
			timeout: 10,
		});

		expect(result.exitCode).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(2_500);
	});

	it.skipIf(process.platform === "win32")(
		"waits for inherited daemon pipes to close before returning cancellation",
		async () => {
			const host = createNodeForegroundCommandHost({ resolveShell: nodeShell });
			const cwd = mkdtempSync(join(tmpdir(), "vetta-foreground-close-"));
			const controller = new AbortController();
			// A failed readiness handshake must not leave a detached test process alive.
			const daemonScript =
				"setTimeout(() => process.exit(1), 15000);process.send('ready');process.disconnect();setInterval(() => {}, 1000)";
			const command = [
				"const { spawn } = require('node:child_process')",
				`const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(daemonScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
				"daemon.once('message', () => process.stdout.write('daemon:' + daemon.pid + '\\n'))",
				"daemon.unref()",
				"setInterval(() => {}, 1000)",
			].join(";");
			let daemonPid: number | undefined;
			let reportReady!: () => void;
			const ready = new Promise<void>((resolve) => {
				reportReady = resolve;
			});
			let output = "";
			let settled = false;
			const execution = host.operations.exec(command, cwd, {
				onData: (data) => {
					output += Buffer.from(data).toString("utf8");
					const match = /daemon:(\d+)\n/.exec(output);
					if (match) {
						daemonPid = Number(match[1]);
						reportReady();
					}
				},
				env: { HOME: cwd, TMPDIR: cwd },
				signal: controller.signal,
			});
			void execution.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await Promise.race([
					ready,
					execution.then(() => {
						throw new Error("Command exited before daemon readiness.");
					}),
				]);
				controller.abort();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				if (daemonPid === undefined) throw new Error("Daemon did not report its process ID.");
				killNodeProcessTree(daemonPid);
				await expect(execution).rejects.toThrow("aborted");
			} finally {
				controller.abort();
				if (daemonPid !== undefined) killNodeProcessTree(daemonPid);
				await execution.catch(() => undefined);
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	it("owns background process output and normalization", async () => {
		const service = createBackgroundCommandService(
			createNodeBackgroundCommandHost({
				resolveShell: nodeShell,
				normalizeOutput: (value) => value.toUpperCase(),
			}),
		);
		try {
			const task = service.spawn({
				command: "process.stdout.write('background-ok')",
				cwd: process.cwd(),
				env: { ...process.env },
			});
			const result = await service.wait(task.id, { maxMs: 10_000 });

			expect(result.stillRunning).toBe(false);
			expect(result.snapshot).toMatchObject({ status: "completed", exitCode: 0 });
			expect(result.snapshot.tail).toBe("BACKGROUND-OK");
		} finally {
			await service.shutdown();
		}
	});

	it("completes a background command when a daemon keeps inherited output pipes open", async () => {
		const service = createBackgroundCommandService(createNodeBackgroundCommandHost({ resolveShell: nodeShell }));
		try {
			const startedAt = Date.now();
			const task = service.spawn({
				command: createDaemonCommand(),
				cwd: process.cwd(),
				env: { ...process.env },
			});
			const result = await service.wait(task.id, { maxMs: 2_500 });

			expect(result.stillRunning).toBe(false);
			expect(result.snapshot).toMatchObject({ status: "completed", exitCode: 0 });
			expect(Date.now() - startedAt).toBeLessThan(2_500);
		} finally {
			await service.shutdown();
		}
	});
});

function createDaemonCommand(): string {
	const daemonScript = "setTimeout(() => process.exit(0), 5000)";
	return [
		"const { spawn } = require('node:child_process')",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(daemonScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })`,
		"child.unref()",
	].join(";");
}
