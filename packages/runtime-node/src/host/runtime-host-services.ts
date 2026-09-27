import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeHostPathServices, RuntimeQueueSidecarStore } from "@vetta/runtime-core";

function queueSidecarPath(sessionPath: string): string {
	return `${sessionPath}.queue.json`;
}

function queueSidecarTemporaryPath(sessionPath: string): string {
	return `${queueSidecarPath(sessionPath)}.tmp`;
}

export const nodeRuntimeHostPathServices: RuntimeHostPathServices = {
	normalize: resolve,
	ensureDirectory: (path) => mkdir(path, { recursive: true }).then(() => undefined),
};

export const nodeRuntimeQueueSidecarStore: RuntimeQueueSidecarStore = {
	async read(sessionPath) {
		const raw = await readFile(queueSidecarPath(sessionPath), "utf8");
		return JSON.parse(raw) as unknown;
	},
	async write(sessionPath, snapshot) {
		const target = queueSidecarPath(sessionPath);
		const temporary = queueSidecarTemporaryPath(sessionPath);
		try {
			// Preserve the last acknowledged target until the next snapshot is complete.
			await writeFile(temporary, JSON.stringify(snapshot), "utf8");
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	},
	async remove(sessionPath) {
		await rm(queueSidecarPath(sessionPath), { force: true });
		await rm(queueSidecarTemporaryPath(sessionPath), { force: true });
	},
};
