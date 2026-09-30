import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWriteTool,
	type WriteOperations,
	type WriteToolDetails,
} from "../../../src/coding/tools/write/write-tool.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "vetta-write-review-"));
	directories.push(path);
	return path;
}
function request(content: string, signal = new AbortController().signal) {
	return {
		sessionId: "session",
		turnId: "turn",
		toolCallId: "write-call",
		input: { path: "output.txt", content },
		signal,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("write results describe committed file changes", () => {
	it("reports a created UTF-8 file with a real diff and byte count", async () => {
		const root = await directory();
		const tool = createWriteTool(root, { pathPolicy: { getRejectionReason: () => undefined } });
		const result = await tool.execute(request("héllo🙂\n"));
		expect(await readFile(join(root, "output.txt"), "utf8")).toBe("héllo🙂\n");
		expect(result.details).toEqual({
			path: join(root, "output.txt"),
			bytesWritten: 11,
			changeKind: "created",
			diffStatus: "available",
			diffBasis: "pre-write-read",
			diff: "+1 héllo🙂",
			firstChangedLine: 1,
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Successfully wrote 11 bytes") });
	});

	it("reports overwritten contents and an unchanged rewrite without inventing added lines", async () => {
		const root = await directory();
		await writeFile(join(root, "output.txt"), "first\nold\nlast\n");
		const tool = createWriteTool(root, { pathPolicy: { getRejectionReason: () => undefined } });
		const modified = await tool.execute(request("first\nnew\nlast\n"));
		expect(modified.details).toMatchObject({ changeKind: "modified", diffStatus: "available", firstChangedLine: 2 });
		expect((modified.details as WriteToolDetails).diff).toContain("-2 old\n+2 new");
		const unchanged = await tool.execute(request("first\nnew\nlast\n"));
		expect(unchanged.details).toMatchObject({ changeKind: "unchanged", diffStatus: "available", diff: "" });
	});

	it("describes the actual encoded bytes for unpaired surrogates", async () => {
		const root = await directory();
		const tool = createWriteTool(root, { pathPolicy: { getRejectionReason: () => undefined } });
		const result = await tool.execute(request("\ud800"));
		expect(await readFile(join(root, "output.txt"), "utf8")).toBe("\ufffd");
		expect(result.details).toMatchObject({ bytesWritten: 3, diff: "+1 \ufffd" });
	});

	it("keeps the inclusive 64 KiB boundary reviewable and rejects oversized old local content", async () => {
		const root = await directory();
		const tool = createWriteTool(root, { pathPolicy: { getRejectionReason: () => undefined } });
		const boundary = await tool.execute(request("x".repeat(64 * 1024)));
		expect(boundary.details).toMatchObject({ bytesWritten: 64 * 1024, diffStatus: "available" });
		await writeFile(join(root, "output.txt"), "x".repeat(64 * 1024 + 1));
		const over = await tool.execute(request("small"));
		expect(over.details).toMatchObject({ diffStatus: "unavailable", diffUnavailableReason: "too-large" });
		expect(await readFile(join(root, "output.txt"), "utf8")).toBe("small");
	});

	it("keeps legacy write-only ports working and reports the unavailable before-image", async () => {
		let written = "";
		const tool = createWriteTool(await directory(), {
			pathPolicy: { getRejectionReason: () => undefined },
			operations: {
				mkdir: async () => {},
				writeFile: async (_path, content) => {
					written = content;
				},
			},
		});
		const result = await tool.execute(request("new"));
		expect(written).toBe("new");
		expect(result.details).toMatchObject({
			changeKind: "unknown",
			diffStatus: "unavailable",
			diffUnavailableReason: "not-supported",
		});
		expect((result.details as WriteToolDetails).diff).toBeUndefined();
	});

	it("does not require read permission in order to preserve an authorized write", async () => {
		let written = "";
		const tool = createWriteTool(await directory(), {
			pathPolicy: { getRejectionReason: () => undefined },
			operations: {
				mkdir: async () => {},
				writeFile: async (_path, content) => {
					written = content;
				},
				readForDiff: async () => {
					throw Object.assign(new Error("no read permission"), { code: "EACCES" });
				},
			},
		});
		const result = await tool.execute(request("replacement"));
		expect(written).toBe("replacement");
		expect(result.details).toMatchObject({
			changeKind: "unknown",
			diffStatus: "unavailable",
			diffUnavailableReason: "read-unavailable",
		});
		expect((result.details as WriteToolDetails).diff).toBeUndefined();
	});

	it("does not misrepresent binary or invalid UTF-8 contents as a text diff", async () => {
		const root = await directory();
		const tool = createWriteTool(root, { pathPolicy: { getRejectionReason: () => undefined } });
		for (const old of [Buffer.from([0, 1, 2]), Buffer.from([255, 254])]) {
			await writeFile(join(root, "output.txt"), old);
			const result = await tool.execute(request("text"));
			expect(result.details).toMatchObject({ diffStatus: "unavailable", diffUnavailableReason: "non-text" });
			expect((result.details as WriteToolDetails).diff).toBeUndefined();
			expect(await readFile(join(root, "output.txt"), "utf8")).toBe("text");
		}
	});

	it("bounds before-image reads and skips excessive new content without blocking the write", async () => {
		const root = await directory();
		let readLimit: number | undefined;
		let reads = 0;
		const operations: WriteOperations = {
			mkdir: async () => {},
			writeFile: async () => {},
			readForDiff: async (_path, maxBytes) => {
				reads++;
				readLimit = maxBytes;
				return { kind: "content", bytes: Buffer.alloc(maxBytes + 1, "x") };
			},
		};
		const tool = createWriteTool(root, { operations, pathPolicy: { getRejectionReason: () => undefined } });
		const oldLarge = await tool.execute(request("small"));
		expect(readLimit).toBe(64 * 1024);
		expect(oldLarge.details).toMatchObject({ diffStatus: "unavailable", diffUnavailableReason: "too-large" });
		const newLarge = await tool.execute(request("x".repeat(64 * 1024 + 1)));
		expect(reads).toBe(1);
		expect(newLarge.details).toMatchObject({
			bytesWritten: 64 * 1024 + 1,
			diffStatus: "unavailable",
			diffUnavailableReason: "too-large",
		});
	});

	it("rejects a protected path before attempting reads or writes", async () => {
		const calls: string[] = [];
		const tool = createWriteTool(await directory(), {
			pathPolicy: { getRejectionReason: () => "Protected path" },
			operations: {
				mkdir: async () => {
					calls.push("mkdir");
				},
				writeFile: async () => {
					calls.push("write");
				},
				readForDiff: async () => {
					calls.push("read");
					return { kind: "missing" };
				},
			},
		});
		const result = await tool.execute(request("blocked"));
		expect(calls).toEqual([]);
		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
	});

	it("waits for an in-flight write to settle before reporting cancellation", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const controller = new AbortController();
		let applied = false;
		let settled = false;
		const tool = createWriteTool(await directory(), {
			pathPolicy: { getRejectionReason: () => undefined },
			operations: {
				mkdir: async () => {},
				writeFile: async () => {
					started.resolve();
					await release.promise;
					applied = true;
				},
			},
		});
		const work = tool.execute(request("inflight", controller.signal));
		void work.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const rejected = expect(work).rejects.toThrow("Operation aborted");
		await started.promise;
		controller.abort();
		await setImmediate();
		const settledBeforeWrite = settled;
		release.resolve();
		await rejected;
		expect(settledBeforeWrite).toBe(false);
		expect(applied).toBe(true);
	});
});
