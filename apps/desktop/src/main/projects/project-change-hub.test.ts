import { describe, expect, it } from "vitest";
import { ProjectChangeHub } from "./project-change-hub.js";

describe("ProjectChangeHub", () => {
	it("isolates observer failures and preserves cursor progression", () => {
		const hub = new ProjectChangeHub("00000000-0000-4000-8000-000000000001");
		const received: number[] = [];
		hub.subscribe(() => {
			throw new Error("observer failed");
		});
		hub.subscribe((cursor) => received.push(cursor));

		expect(hub.notify()).toBe(1);
		expect(hub.notify()).toBe(2);
		expect(hub.getGeneration()).toBe("00000000-0000-4000-8000-000000000001");
		expect(received).toEqual([1, 2]);
	});

	it("wakes a wait once and releases the subscription after abort", async () => {
		const hub = new ProjectChangeHub("00000000-0000-4000-8000-000000000001");
		const controller = new AbortController();
		const waiting = hub.waitForChange(0, controller.signal, 1_000);
		hub.notify();
		expect(await waiting).toBe(true);

		const aborted = new AbortController();
		const abortedWait = hub.waitForChange(hub.getCursor(), aborted.signal, 1_000);
		aborted.abort();
		await expect(abortedWait).rejects.toMatchObject({ name: "AbortError" });
		hub.notify();
	});
});
