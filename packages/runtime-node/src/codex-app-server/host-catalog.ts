import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectInfo, RuntimeSessionCatalog, SessionHistoryInfo } from "@vetta/runtime-core";
import type { ConversationOwnershipManager } from "@vetta/runtime-storage/conversation";
import type { CodexSessionRecord } from "./host-contracts.js";
import { object } from "./protocol.js";
import { CodexRuntimeError } from "./types.js";

const SUFFIX = ".codex-session.json";
const MAX_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEYS = new Set(["schemaVersion", "runtime", "sessionId", "threadId", "profileId", "profileFingerprint",
	"cwd", "createdAt", "modifiedAt", "name", "firstMessage", "lastMessagePreview"]);

export function validateSessionId(id: string): string {
	if (!ID.test(id)) throw new CodexRuntimeError("INPUT", "Invalid local Codex session ID");
	return id;
}

function parseRecord(value: unknown): CodexSessionRecord {
	const record = object(value);
	if (Object.keys(record).some((key) => !KEYS.has(key)) || record.schemaVersion !== 1 ||
		record.runtime !== "codex-app-server" || typeof record.sessionId !== "string" || !ID.test(record.sessionId) ||
		typeof record.threadId !== "string" || !record.threadId || record.threadId.length > 256 ||
		typeof record.profileId !== "string" || !ID.test(record.profileId) ||
		typeof record.profileFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.profileFingerprint) ||
		typeof record.cwd !== "string" || !isAbsolute(record.cwd) ||
		typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
		typeof record.modifiedAt !== "number" || !Number.isSafeInteger(record.modifiedAt) || record.modifiedAt < record.createdAt ||
		typeof record.firstMessage !== "string" || record.firstMessage.length > 120 ||
		typeof record.lastMessagePreview !== "string" || record.lastMessagePreview.length > 120 ||
		(record.name !== undefined && (typeof record.name !== "string" || record.name.length > 200))) {
		throw new CodexRuntimeError("CATALOG_INVALID", "Invalid or unsupported Codex session index record");
	}
	return record as unknown as CodexSessionRecord;
}

/** Offline discovery only. Does not read Codex auth, configuration or raw history files. */
export class CodexHostSessionCatalog implements RuntimeSessionCatalog {
	private readonly root: Promise<string>;
	constructor(root: string, private readonly ownership: ConversationOwnershipManager) {
		if (!isAbsolute(root)) throw new CodexRuntimeError("CONFIGURATION", "Codex catalog root must be absolute");
		this.root = mkdir(root, { recursive: true, mode: 0o700 }).then(() => realpath(root));
		void this.root.catch(() => undefined);
	}

	async pathFor(sessionId: string): Promise<string> {
		return join(await this.root, `${validateSessionId(sessionId)}${SUFFIX}`);
	}

	async ownsSession(path: string): Promise<boolean> {
		// Claim our namespace even when a record is corrupt/missing, so routing never falls back to Native.
		return isAbsolute(path) && dirname(resolve(path)) === await this.root &&
			basename(path).endsWith(SUFFIX) && ID.test(basename(path).slice(0, -SUFFIX.length));
	}

	async read(path: string): Promise<CodexSessionRecord> {
		if (!isAbsolute(path)) throw new CodexRuntimeError("CATALOG_FOREIGN", "Session path must be absolute");
		path = resolve(path);
		await this.assertOwned(path);
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) {
			throw new CodexRuntimeError("CATALOG_INVALID", "Codex index is not a bounded regular file");
		}
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_BYTES) {
				throw new CodexRuntimeError("CATALOG_INVALID", "Codex index changed while opening");
			}
			const bytes = Buffer.alloc(MAX_BYTES + 1);
			let bytesRead = 0;
			while (bytesRead < bytes.length) {
				const part = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
				if (part.bytesRead === 0) break;
				bytesRead += part.bytesRead;
			}
			if (bytesRead > MAX_BYTES) throw new CodexRuntimeError("CATALOG_INVALID", "Codex index exceeds size limit");
			const record = parseRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
			if (basename(path) !== `${record.sessionId}${SUFFIX}`) {
				throw new CodexRuntimeError("CATALOG_INVALID", "Codex index identity does not match its filename");
			}
			return record;
		} finally {
			await handle.close();
		}
	}

	/** Caller holds the session ownership lease. Creation must never replace an existing index. */
	async create(record: CodexSessionRecord): Promise<string> {
		const path = await this.pathFor(record.sessionId);
		const bytes = this.encode(record);
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} catch (error) {
			await handle.close();
			await unlink(path).catch(() => undefined);
			throw error;
		}
		await handle.close();
		return path;
	}

	/** Metadata-only update under the caller's lifetime lease; no transcript or secret fields are accepted. */
	async update(path: string, patch: Pick<Partial<CodexSessionRecord>, "name" | "firstMessage" | "lastMessagePreview">): Promise<CodexSessionRecord> {
		if (!isAbsolute(path)) throw new CodexRuntimeError("CATALOG_FOREIGN", "Session path must be absolute");
		path = resolve(path);
		const current = await this.read(path);
		if (Object.keys(patch).some((key) => !["name", "firstMessage", "lastMessagePreview"].includes(key))) {
			throw new CodexRuntimeError("CATALOG_INVALID", "Only display metadata may be updated");
		}
		const next = parseRecord({ ...current, ...patch, modifiedAt: Math.max(Date.now(), current.modifiedAt) });
		const bytes = this.encode(next);
		const temporary = join(await this.root, `.${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
		return next;
	}

	async listProjects(): Promise<ProjectInfo[]> {
		const counts = new Map<string, number>();
		for (const record of await this.records()) counts.set(record.cwd, (counts.get(record.cwd) ?? 0) + 1);
		return [...counts].map(([cwd, sessionCount]) => ({ cwd, sessionCount })).sort((a, b) => a.cwd.localeCompare(b.cwd));
	}

	async listSessions(cwd: string, sessionDir?: string): Promise<SessionHistoryInfo[]> {
		if (sessionDir !== undefined && resolve(sessionDir) !== await this.root) return [];
		const canonical = await realpath(cwd);
		const records = (await this.records()).filter((record) => record.cwd === canonical);
		return Promise.all(records.sort((a, b) => b.modifiedAt - a.modifiedAt).map(async (record) => ({
			id: record.sessionId, path: await this.pathFor(record.sessionId), cwd: record.cwd,
			...(record.name === undefined ? {} : { name: record.name }), firstMessage: record.firstMessage,
			lastMessagePreview: record.lastMessagePreview, modifiedAt: record.modifiedAt,
		})));
	}

	async renameSession(path: string, name: string): Promise<void> {
		if (!isAbsolute(path)) throw new CodexRuntimeError("CATALOG_FOREIGN", "Session path must be absolute");
		path = resolve(path);
		await this.assertOwned(path);
		const lease = await this.ownership.acquire(path);
		try { await this.update(path, { name: this.validateName(name) }); } finally { await lease.release(); }
	}

	async deleteSessionArtifacts(_path: string): Promise<void> {
		throw new CodexRuntimeError("UNSUPPORTED", "Deleting Codex-owned history is not supported by this backend");
	}

	validateName(name: string): string {
		if (!name.trim() || name.length > 200) throw new CodexRuntimeError("INPUT", "A name of 1–200 characters is required");
		return name.trim();
	}

	private async records(): Promise<CodexSessionRecord[]> {
		const root = await this.root;
		const names = (await readdir(root)).filter((name) => name.endsWith(SUFFIX));
		const records: CodexSessionRecord[] = [];
		for (const name of names.sort()) records.push(await this.read(join(root, name)));
		return records;
	}

	private async assertOwned(path: string): Promise<void> {
		if (!await this.ownsSession(path)) throw new CodexRuntimeError("CATALOG_FOREIGN", "Path is not owned by the Codex catalog");
	}

	private encode(record: CodexSessionRecord): string {
		const bytes = `${JSON.stringify(parseRecord(record))}\n`;
		if (Buffer.byteLength(bytes) > MAX_BYTES) throw new CodexRuntimeError("CATALOG_INVALID", "Codex index exceeds size limit");
		return bytes;
	}
}
