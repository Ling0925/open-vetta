import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteTool, remotePosixToolPathHost } from "@vetta/runtime-node/coding";
import { createNodeSshProcessRunner, SshConnection } from "@vetta/ssh-transport";
import { afterEach, describe, expect, it } from "vitest";
import { createSshWriteOperations } from "./ssh-file-operations.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "vetta-ssh-write-review-"));
	roots.push(root);
	const ssh = join(root, "ssh");
	// Replace only the SSH process boundary: real command quoting, decoding, file operations and tool run locally.
	await writeFile(ssh, '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
	const connection = new SshConnection(
		{ id: "fixture", label: "Fixture", target: "fixture", source: "manual" },
		{
			runner: createNodeSshProcessRunner({
				sshBinary: ssh,
				baseEnv: { ...process.env, HOME: root, SHELL: "/bin/sh" },
			}),
			controlPath: join(root, "control"),
		},
	);
	const tool = createWriteTool(root, {
		operations: createSshWriteOperations(connection),
		pathHost: remotePosixToolPathHost,
		pathPolicy: { getRejectionReason: () => undefined },
	});
	return { root, tool };
}

function request(content: string) {
	return {
		sessionId: "session",
		turnId: "turn",
		toolCallId: "call",
		input: { path: "remote file.txt", content },
		signal: new AbortController().signal,
	};
}

describe("SSH writes share native review results", () => {
	it("reports the remote before-image and UTF-8 byte count after a real quoted write", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "remote file.txt"), "old\n");
		const result = await f.tool.execute(request("新🙂\n"));
		expect(await readFile(join(f.root, "remote file.txt"), "utf8")).toBe("新🙂\n");
		expect(result.details).toMatchObject({
			bytesWritten: 8,
			changeKind: "modified",
			diffStatus: "available",
			diff: "-1 old\n+1 新🙂",
		});
	});

	it("does not infer an empty before-image when the shell cannot read the path", async () => {
		const f = await fixture();
		const result = await f.tool.execute(request("created through SSH\n"));
		expect(await readFile(join(f.root, "remote file.txt"), "utf8")).toBe("created through SSH\n");
		expect(result.details).toMatchObject({
			changeKind: "unknown",
			diffStatus: "unavailable",
			diffUnavailableReason: "read-unavailable",
		});
		expect(result.details).not.toHaveProperty("diff");
	});

	it("caps the remote before-image without preventing a larger file from being replaced", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "remote file.txt"), "x".repeat(64 * 1024 + 1));
		const result = await f.tool.execute(request("small"));
		expect(await readFile(join(f.root, "remote file.txt"), "utf8")).toBe("small");
		expect(result.details).toMatchObject({ diffStatus: "unavailable", diffUnavailableReason: "too-large" });
	});
});
