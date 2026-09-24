import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeHostSessionBackend, RuntimeSessionCreateRequest } from "@vetta/runtime-core";
import type { ConversationOwnershipLease } from "@vetta/runtime-storage/conversation";
import { CodexHostSessionCatalog, validateSessionId } from "./host-catalog.js";
import { CODEX_HOST_CAPABILITIES, type CodexHostAssembly, type CodexHostBackendOptions, type CodexHostProfile, type CodexSessionRecord } from "./host-contracts.js";
import { CodexHostSession } from "./host-session.js";
import { openCodexAppServerSession } from "./runtime.js";
import type { CodexAppServerSession } from "./session.js";
import { CodexRuntimeError } from "./types.js";

/** RuntimeHost backend with persistent Thread association and existing storage-owned lifetime leases. */
export class CodexRuntimeHostBackend implements RuntimeHostSessionBackend {
	readonly catalog: CodexHostSessionCatalog;
	readonly capabilities = CODEX_HOST_CAPABILITIES;
	private readonly profile: CodexHostProfile;
	private readonly sessions = new Map<string, CodexHostSession>();
	private readonly pending = new Set<Promise<CodexHostAssembly>>();
	private disposed = false;
	private closing?: Promise<void>;

	constructor(private readonly options: CodexHostBackendOptions) {
		validateSessionId(options.profile.id);
		if (!isAbsolute(options.profile.executable) || !isAbsolute(options.profile.codexHome)) {
			throw new CodexRuntimeError("CONFIGURATION", "Codex profile executable and home must be absolute");
		}
		this.profile = Object.freeze({ ...options.profile,
			...(options.profile.executableArgs ? { executableArgs: Object.freeze([...options.profile.executableArgs]) } : {}) });
		this.catalog = new CodexHostSessionCatalog(options.catalogRoot, options.ownership);
	}

	createAssembly(request: RuntimeSessionCreateRequest): Promise<CodexHostAssembly> {
		if (this.disposed) return Promise.reject(new CodexRuntimeError("CLOSED", "Codex backend is closed"));
		const pending = this.create(request);
		this.pending.add(pending);
		void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
		return pending;
	}

	readSnapshot(sessionId: string): ReturnType<CodexHostSession["readSnapshot"]> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new CodexRuntimeError("SESSION_NOT_FOUND", "Codex session is not open in this backend");
		return session.readSnapshot();
	}

	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.disposed = true;
		this.closing = (async () => {
			await Promise.allSettled([...this.pending]);
			const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
			const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
			if (errors.length) throw new AggregateError(errors, "Codex backend cleanup could not be confirmed");
		})();
		return this.closing;
	}

	private async create(request: RuntimeSessionCreateRequest): Promise<CodexHostAssembly> {
		this.validateRequest(request);
		const profile = { ...this.profile, codexHome: await realpath(this.profile.codexHome),
			executable: await realpath(this.profile.executable) };
		const fingerprint = createHash("sha256").update(JSON.stringify({ id: profile.id, home: profile.codexHome,
			executable: profile.executable, executableArgs: profile.executableArgs ?? [], version: profile.expectedVersion,
			model: profile.model ?? null, sandbox: profile.sandbox ?? "read-only" })).digest("hex");
		const sessionId = request.sessionId ?? randomUUID();
		const path = request.sessionPath ? resolve(request.sessionPath) : await this.catalog.pathFor(sessionId);
		if (!await this.catalog.ownsSession(path)) throw new CodexRuntimeError("CATALOG_FOREIGN", "Codex backend cannot open a Native session");
		if (request.sessionDir !== undefined && await realpath(request.sessionDir) !== dirname(path)) {
			throw new CodexRuntimeError("CONFIGURATION", "Codex sessionDir must match its configured catalog");
		}
		const lease = await this.options.ownership.acquire(path);
		let threadLease: ConversationOwnershipLease | undefined;
		let remote: CodexAppServerSession | undefined;
		try {
			this.assertOpen();
			let record: CodexSessionRecord | undefined;
			if (request.sessionPath) {
				record = await this.catalog.read(path);
				if (record.profileId !== profile.id || record.profileFingerprint !== fingerprint) {
					throw new CodexRuntimeError("PROFILE_MISMATCH", "Codex profile changed; explicitly reconcile before resuming this thread");
				}
				if (request.sessionId !== undefined && request.sessionId !== record.sessionId) {
					throw new CodexRuntimeError("IDENTITY_MISMATCH", "Requested session ID disagrees with the Codex index");
				}
			} else {
				try {
					await this.catalog.read(path);
					throw new CodexRuntimeError("SESSION_EXISTS", "Codex session ID already exists; use its saved path to resume");
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
			}
			const cwd = await realpath(request.cwd ?? record?.cwd ?? "");
			if (record && (cwd !== record.cwd || await realpath(record.cwd) !== record.cwd)) {
				throw new CodexRuntimeError("WORKSPACE_MISMATCH", "Codex session workspace changed");
			}
			if (inside(cwd, profile.codexHome) || inside(cwd, dirname(path))) {
				throw new CodexRuntimeError("CONFIGURATION", "Codex home and catalog must be outside the task workspace");
			}
			const claimThread = (threadId: string) => this.options.ownership.acquire(join(profile.codexHome, ".vetta-runtime-leases",
				createHash("sha256").update(threadId).digest("hex")));
			if (record) threadLease = await claimThread(record.threadId);
			this.assertOpen();
			remote = await (this.options.connect ?? openCodexAppServerSession)({ ...profile, cwd,
				...(record ? { threadId: record.threadId } : {}) });
			this.assertOpen();
			if (record && remote.threadId !== record.threadId) throw new CodexRuntimeError("IDENTITY_MISMATCH", "Codex resumed another thread");
			if (!record) {
				threadLease = await claimThread(remote.threadId);
				const now = Date.now();
				record = { schemaVersion: 1, runtime: "codex-app-server", sessionId, threadId: remote.threadId,
					profileId: profile.id, profileFingerprint: fingerprint, cwd, createdAt: now, modifiedAt: now,
					firstMessage: "", lastMessagePreview: "" };
				await this.catalog.create(record);
			}
			this.assertOpen();
			const openedId = record.sessionId;
			const ownedThreadLease = threadLease;
			const session = new CodexHostSession(remote, record, path, this.catalog, async () => {
				await ownedThreadLease?.release();
				await lease.release();
				this.sessions.delete(openedId);
			});
			this.sessions.set(openedId, session);
			return session.assembly;
		} catch (error) {
			// Keep leases if process shutdown fails: opening a second owner would be unsafe.
			try {
				await remote?.close();
				await threadLease?.release();
				await lease.release();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Codex initialization and rollback failed");
			}
			throw error;
		}
	}

	private validateRequest(request: RuntimeSessionCreateRequest): void {
		if (request.executionMode !== "sandbox") throw new CodexRuntimeError("UNSUPPORTED", "Codex backend does not allow full-access mode");
		if (!request.sessionPath && (!request.cwd || !isAbsolute(request.cwd))) {
			throw new CodexRuntimeError("INPUT", "New Codex sessions require an absolute workspace");
		}
		if (request.sessionPath !== undefined && !isAbsolute(request.sessionPath)) {
			throw new CodexRuntimeError("INPUT", "Session path must be absolute");
		}
		if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw new CodexRuntimeError("INPUT", "Workspace must be absolute");
		if (request.model !== undefined || request.thinkingLevel !== undefined || request.env !== undefined || request.agent !== undefined || request.agentDir !== undefined) {
			throw new CodexRuntimeError("UNSUPPORTED", "Native model, Agent configuration, reasoning and environment overrides cannot be applied to Codex");
		}
		if (request.sessionId !== undefined) validateSessionId(request.sessionId);
	}

	private assertOpen(): void {
		if (this.disposed) throw new CodexRuntimeError("CLOSED", "Codex backend closed during initialization");
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function inside(root: string, target: string): boolean {
	const difference = relative(root, target);
	return !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}
