import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { deferred, positive } from "./protocol.js";
import { CodexRuntimeError, type CodexLaunchOptions, type CodexTransport, type JsonObject, type TransportEvent } from "./types.js";
function environment(home?: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	// Do not accidentally forward Vetta/provider tokens to another execution backend.
	for (const name of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT",
		"TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"SSL_CERT_FILE", "SSL_CERT_DIR"]) {
		if (process.env[name] !== undefined)
			result[name] = process.env[name];
	}
	if (home)
		result.CODEX_HOME = home;
	return result;
}
/** Owns exactly one local stdio process, never attaches to an unrelated running Codex. */
export class CodexStdioTransport implements CodexTransport {
	private readonly listeners = new Set<(event: TransportEvent) => void>();
	private readonly ended = deferred<void>();
	private readonly maxBytes: number;
	private readonly shutdownMs: number;
	private buffer = Buffer.alloc(0);
	private failure?: Error;
	private closing?: Promise<void>;
	private didExit = false;
	private constructor(private readonly child: ChildProcessWithoutNullStreams, options: CodexLaunchOptions) {
		this.maxBytes = positive(options.maxFrameBytes, 8 * 1024 * 1024);
		this.shutdownMs = positive(options.shutdownTimeoutMs, 2000);
		child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
		// Drain stderr without persisting model content, credentials or the user's configuration.
		child.stderr.resume();
		child.stdin.on("error", () => this.fail(new CodexRuntimeError("TRANSPORT", "App-server input pipe failed")));
		child.stdout.on("error", () => this.fail(new CodexRuntimeError("TRANSPORT", "App-server output pipe failed")));
		child.stderr.on("error", () => undefined);
		child.once("error", () => this.fail(new CodexRuntimeError("PROCESS_START", "Unable to start the configured Codex executable")));
		child.once("close", () => {
			this.didExit = true;
			this.ended.resolve();
			this.fail(new CodexRuntimeError("PROCESS_EXIT", "App-server exited; an in-flight operation may need reconciliation"));
		});
	}
	static async launch(options: CodexLaunchOptions, routing?: { readonly localGateway: boolean }): Promise<CodexStdioTransport> {
		if (!isAbsolute(options.executable) || !isAbsolute(options.cwd) || (options.codexHome && !isAbsolute(options.codexHome))) {
			throw new CodexRuntimeError("CONFIGURATION", "Codex executable, cwd and optional home must be absolute paths");
		}
		if (!/^[0-9][0-9A-Za-z.+-]*$/.test(options.expectedVersion)) {
			throw new CodexRuntimeError("CONFIGURATION", "An exact, host-verified Codex version is required");
		}
		positive(options.maxFrameBytes, 8 * 1024 * 1024);
		positive(options.shutdownTimeoutMs, 2000);
		const timeout = positive(options.startupTimeoutMs, 10000);
		const cwd = await realpath(options.cwd);
		const env = environment(options.codexHome);
		if (routing?.localGateway) {
			// The host handles upstream routing; never send a local bearer through a system proxy.
			delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.ALL_PROXY;
			env.NO_PROXY = "*";
		}
		const version = await new Promise<string>((resolve, reject) => {
			execFile(options.executable, [...(options.executableArgs ?? []), "--version"], {
				cwd, env, timeout, maxBuffer: 2048, windowsHide: true, encoding: "utf8",
			}, (error, stdout) => {
				if (error)
					reject(new CodexRuntimeError("PROCESS_START", "Codex version probe failed"));
				else
					resolve(stdout.trim());
			});
		});
		if (version !== `codex-cli ${options.expectedVersion}`) {
			throw new CodexRuntimeError("VERSION_MISMATCH", "Installed Codex does not match the host-verified version");
		}
		const child = spawn(options.executable, [...(options.executableArgs ?? []), "app-server", "--listen", "stdio://"], {
			cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
			detached: process.platform !== "win32",
		});
		return new CodexStdioTransport(child, options);
	}
	subscribe(listener: (event: TransportEvent) => void): () => void {
		this.listeners.add(listener);
		if (this.failure)
			queueMicrotask(() => {
				if (this.listeners.has(listener) && this.failure) {
					try {
						listener({ type: "failure", error: this.failure });
					}
					catch { /* Observer isolation. */ }
				}
			});
		return () => this.listeners.delete(listener);
	}
	send(message: JsonObject): Promise<void> {
		if (this.closing || this.failure)
			return Promise.reject(new CodexRuntimeError("CLOSED", "App-server transport is closed"));
		const line = `${JSON.stringify(message)}\n`;
		const bytes = Buffer.byteLength(line);
		if (bytes > this.maxBytes || this.child.stdin.writableLength + bytes > this.maxBytes * 2) {
			return Promise.reject(new CodexRuntimeError("LIMIT", "App-server output/backpressure limit exceeded"));
		}
		return new Promise((resolve, reject) => {
			this.child.stdin.write(line, (error) => error ? reject(new CodexRuntimeError("TRANSPORT", "App-server write failed")) : resolve());
		});
	}
	close(): Promise<void> {
		this.closing ??= Promise.resolve().then(() => this.shutdown());
		return this.closing;
	}
	private receive(chunk: Buffer): void {
		if (this.failure || this.closing)
			return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		let newline = this.buffer.indexOf(10);
		while (newline >= 0) {
			if (newline > this.maxBytes) {
				this.fail(new CodexRuntimeError("LIMIT", "App-server frame is too large"));
				return;
			}
			const line = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (line.length > 0) {
				try {
					this.emit({ type: "message", message: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) });
				}
				catch {
					this.fail(new CodexRuntimeError("PROTOCOL", "App-server returned malformed JSON"));
					return;
				}
			}
			if (this.failure || this.closing)
				return;
			newline = this.buffer.indexOf(10);
		}
		if (this.buffer.length > this.maxBytes)
			this.fail(new CodexRuntimeError("LIMIT", "Unterminated app-server frame is too large"));
	}
	private emit(event: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			}
			catch { /* Observer isolation. */ }
		}
	}
	private fail(error: Error): void {
		if (this.failure)
			return;
		this.failure = error;
		this.buffer = Buffer.alloc(0);
		this.emit({ type: "failure", error });
		void this.close().catch(() => undefined);
	}
	private async shutdown(): Promise<void> {
		this.child.stdin.end();
		if (await this.waitForExit(this.shutdownMs))
			return;
		await this.killTree();
		if (!(await this.waitForExit(this.shutdownMs))) {
			throw new CodexRuntimeError("PROCESS_SHUTDOWN", "Unable to confirm app-server process exit");
		}
	}
	private async waitForExit(ms: number): Promise<boolean> {
		if (this.didExit)
			return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([this.ended.promise.then(() => true), new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), ms);
				})]);
		}
		finally {
			if (timer)
				clearTimeout(timer);
		}
	}
	private async killTree(): Promise<void> {
		const pid = this.child.pid;
		if (!pid || this.didExit)
			return;
		if (process.platform === "win32") {
			await new Promise<void>((resolve) => execFile("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { timeout: this.shutdownMs, windowsHide: true }, () => resolve()));
			return;
		}
		try {
			process.kill(-pid, "SIGKILL");
		}
		catch {
			this.child.kill("SIGKILL");
		}
	}
}
