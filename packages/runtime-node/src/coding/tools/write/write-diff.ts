import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { generateDiffString } from "../../shared/file-diff.js";
import type {
	WriteDiffUnavailableReason,
	WriteFileSnapshot,
	WriteOperations,
	WriteToolDetails,
} from "./write-contracts.js";

const MAX_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 2048;
type WriteChange = Omit<WriteToolDetails, "path" | "bytesWritten">;

export const readLocalFileForDiff: NonNullable<WriteOperations["readForDiff"]> = async (path, maxBytes, signal) => {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		// Nonblocking open prevents a FIFO/device from trapping an otherwise valid write preview.
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
			return { kind: "missing" };
		throw error;
	}
	try {
		if (!(await file.stat()).isFile()) throw new Error("Diff preview requires a regular file");
		const bytes = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return { kind: "content", bytes: bytes.subarray(0, offset) };
	} finally {
		await file.close();
	}
};

export async function captureWriteChange(
	operations: WriteOperations,
	path: string,
	content: string,
	signal: AbortSignal,
): Promise<WriteChange> {
	if (Buffer.byteLength(content, "utf8") > MAX_DIFF_BYTES || content.split("\n").length > MAX_DIFF_LINES)
		return unavailable("too-large");
	// Match UTF-8 writes even when the model supplied an unpaired UTF-16 surrogate.
	content = Buffer.from(content, "utf8").toString("utf8");
	if (!operations.readForDiff) return unavailable("not-supported");
	let before: WriteFileSnapshot;
	try {
		before = await operations.readForDiff(path, MAX_DIFF_BYTES, signal);
	} catch {
		// Preview is optional: lack of read permission must not prevent an otherwise authorized write.
		return unavailable("read-unavailable");
	}
	if (before.kind === "content" && before.bytes.byteLength > MAX_DIFF_BYTES) return unavailable("too-large");
	let previous = "";
	try {
		if (before.kind === "content")
			previous = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before.bytes);
	} catch {
		return unavailable("non-text");
	}
	if (hasBinaryControls(previous) || hasBinaryControls(content)) return unavailable("non-text");
	if (previous.split("\n").length > MAX_DIFF_LINES) return unavailable("too-large");
	const preview = generateDiffString(previous, content);
	if (Buffer.byteLength(preview.diff, "utf8") > MAX_DIFF_BYTES * 2) return unavailable("too-large");
	return {
		changeKind: before.kind === "missing" ? "created" : previous === content ? "unchanged" : "modified",
		diffStatus: "available",
		diffBasis: "pre-write-read",
		diff: preview.diff,
		...(preview.firstChangedLine === undefined ? {} : { firstChangedLine: preview.firstChangedLine }),
	};
}

function unavailable(reason: WriteDiffUnavailableReason): WriteChange {
	return { changeKind: "unknown", diffStatus: "unavailable", diffUnavailableReason: reason };
}

function hasBinaryControls(value: string): boolean {
	return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
