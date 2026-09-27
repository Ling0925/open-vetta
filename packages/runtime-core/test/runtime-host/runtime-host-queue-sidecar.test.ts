import { describe, expect, it, vi } from "vitest";
import type { QueueChangedEvent } from "../../src/contracts.js";
import { RuntimeHostQueueSidecar } from "../../src/runtime-host/runtime-host-queue-sidecar.js";
import type { RuntimeSessionQueueController } from "../../src/runtime-host/session-ports.js";
import type { RuntimeQueueSidecarStore } from "../../src/runtime-host/session-services.js";

describe("RuntimeHostQueueSidecar", () => {
	it("serializes writes for the same normalized Session path", async () => {
		let releaseFirst!: () => void;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const calls: string[] = [];
		const store = createStore({
			write: async (_path, snapshot) => {
				calls.push(String(snapshot));
				if (snapshot === "first") await firstWrite;
			},
		});
		const sidecar = new RuntimeHostQueueSidecar({
			store,
			normalizePath: (path) => path.toLowerCase(),
		});

		sidecar.persist("C:/Session.jsonl", event("first"));
		sidecar.persist("c:/session.jsonl", event("second"));
		await Promise.resolve();
		expect(calls).toEqual(["first"]);

		releaseFirst();
		await vi.waitFor(() => expect(calls).toEqual(["first", "second"]));
	});

	it("reports persistence failures and makes flush fail closed", async () => {
		const failure = new Error("disk unavailable");
		const reportFailure = vi.fn();
		const remove = vi.fn(async () => {
			throw failure;
		});
		const sidecar = new RuntimeHostQueueSidecar({ store: createStore({ remove }), reportFailure });

		sidecar.persist("session.jsonl", event(undefined, true));

		await expect(sidecar.flush("session.jsonl")).rejects.toBe(failure);
		expect(reportFailure).toHaveBeenCalledWith(failure, "session");
	});

	it("flush waits for the newest admitted write for one normalized Session path", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writes: string[] = [];
		const sidecar = new RuntimeHostQueueSidecar({
			store: createStore({
				write: async (_path, snapshot) => {
					writes.push(String(snapshot));
					await gate;
				},
			}),
			normalizePath: (path) => path.toLowerCase(),
		});

		sidecar.persist("C:/Session.jsonl", event("accepted"));
		let flushed = false;
		const pending = sidecar.flush("c:/session.jsonl").then(() => {
			flushed = true;
		});
		await Promise.resolve();
		expect(writes).toEqual(["accepted"]);
		expect(flushed).toBe(false);

		release();
		await pending;
		expect(flushed).toBe(true);
	});

	it("clears a prior failure after a newer snapshot persists successfully", async () => {
		let fail = true;
		const sidecar = new RuntimeHostQueueSidecar({
			store: createStore({
				write: async () => {
					if (fail) throw new Error("first write failed");
				},
			}),
		});
		sidecar.persist("session.jsonl", event("first"));
		await expect(sidecar.flush("session.jsonl")).rejects.toThrow("first write failed");

		fail = false;
		sidecar.persist("session.jsonl", event("second"));
		await expect(sidecar.flush("session.jsonl")).resolves.toBeUndefined();
	});

	it("restores a valid snapshot and ignores read failures", async () => {
		const restoreQueue = vi.fn();
		const queueController = { restoreQueue } as unknown as RuntimeSessionQueueController;
		const sidecar = new RuntimeHostQueueSidecar({
			store: createStore({ read: async () => ({ entries: ["queued"] }) }),
		});

		await sidecar.restore(queueController, "session.jsonl");
		expect(restoreQueue).toHaveBeenCalledWith({ entries: ["queued"] });

		const failing = new RuntimeHostQueueSidecar({
			store: createStore({ read: async () => Promise.reject(new Error("damaged")) }),
		});
		await expect(failing.restore(queueController, "damaged.jsonl")).resolves.toBeUndefined();
	});
});

function event(snapshot: unknown, empty = false): QueueChangedEvent {
	return {
		type: "queue.changed",
		sessionId: "session",
		paused: false,
		entries: empty ? [] : [{ id: "queued" }],
		snapshot,
	} as unknown as QueueChangedEvent;
}

function createStore(overrides: Partial<RuntimeQueueSidecarStore> = {}): RuntimeQueueSidecarStore {
	return {
		read: async () => undefined,
		write: async () => {},
		remove: async () => {},
		...overrides,
	};
}
