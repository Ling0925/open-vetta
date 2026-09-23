import type { IpcRendererEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
	createElectronHostTransport,
	type ElectronHostIpcRenderer,
	type ElectronHostWebUtils,
} from "./electron-host-transport.js";

type NativeListener = Parameters<ElectronHostIpcRenderer["on"]>[1];

type NativeHarness = {
	readonly ipc: ElectronHostIpcRenderer;
	readonly invoke: ReturnType<typeof vi.fn>;
	readonly send: ReturnType<typeof vi.fn>;
	readonly sendSync: ReturnType<typeof vi.fn>;
	readonly on: ReturnType<typeof vi.fn>;
	readonly removeListener: ReturnType<typeof vi.fn>;
	emit(channel: string, ...args: unknown[]): void;
};

function createNativeHarness(): NativeHarness {
	const listeners = new Map<string, NativeListener[]>();
	const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => "async-result");
	const send = vi.fn();
	const sendSync = vi.fn(() => "sync-result");
	const on = vi.fn((channel: string, listener: NativeListener) => {
		const channelListeners = listeners.get(channel) ?? [];
		channelListeners.push(listener);
		listeners.set(channel, channelListeners);
		return ipc;
	});
	const removeListener = vi.fn((channel: string, listener: NativeListener) => {
		const channelListeners = listeners.get(channel) ?? [];
		const index = channelListeners.lastIndexOf(listener);
		if (index >= 0) channelListeners.splice(index, 1);
		return ipc;
	});
	const ipc: ElectronHostIpcRenderer = { invoke, send, sendSync, on, removeListener };
	return {
		ipc,
		invoke,
		send,
		sendSync,
		on,
		removeListener,
		emit(channel, ...args) {
			for (const listener of listeners.get(channel) ?? []) listener({} as IpcRendererEvent, ...args);
		},
	};
}

describe("createElectronHostTransport", () => {
	it("forwards async, fire-and-forget, sync and file-path operations without changing errors", async () => {
		const native = createNativeHarness();
		const file = new File(["image"], "image.png", { type: "image/png" });
		const getPathForFile = vi.fn(() => "C:/workspace/image.png");
		const webUtils: ElectronHostWebUtils = { getPathForFile };
		const transport = createElectronHostTransport(native.ipc, webUtils);

		const payload = { value: 1 };
		await expect(transport.ipc.invoke<string>("async", payload, "target")).resolves.toBe("async-result");
		transport.ipc.send("send", "payload");
		expect(transport.ipc.sendSync<string>("sync", payload, "fallback")).toBe("sync-result");
		expect(transport.filePath.getPathForFile(file)).toBe("C:/workspace/image.png");
		expect(getPathForFile).toHaveBeenCalledWith(file);
		expect(native.invoke).toHaveBeenCalledWith("async", payload, "target");
		expect(native.send).toHaveBeenCalledWith("send", "payload");
		expect(native.sendSync).toHaveBeenCalledWith("sync", payload, "fallback");

		const failure = new Error("transport failure");
		native.invoke.mockRejectedValueOnce(failure);
		await expect(transport.ipc.invoke("failed")).rejects.toBe(failure);
		native.sendSync.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => transport.ipc.sendSync("failed-sync")).toThrow(failure);
		native.send.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => transport.ipc.send("failed-send")).toThrow(failure);
		native.invoke.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => transport.ipc.invoke("failed-before-promise")).toThrow(failure);
		getPathForFile.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => transport.filePath.getPathForFile(file)).toThrow(failure);
	});

	it("removes the latest duplicate without changing event order or other subscriptions", () => {
		const native = createNativeHarness();
		const transport = createElectronHostTransport(native.ipc, { getPathForFile: () => "" });
		const trace: string[] = [];
		const listenerA = (_event: unknown, value: unknown) => trace.push(`A:${String(value)}`);
		const listenerB = (_event: unknown, value: unknown) => trace.push(`B:${String(value)}`);

		transport.ipc.on("event", listenerA);
		transport.ipc.on("event", listenerB);
		transport.ipc.on("event", listenerA);
		transport.ipc.on("other", listenerA);
		native.emit("event", "first");
		expect(trace).toEqual(["A:first", "B:first", "A:first"]);

		trace.length = 0;
		transport.ipc.removeListener("event", listenerA);
		native.emit("event", "second");
		native.emit("other", "independent");
		expect(trace).toEqual(["A:second", "B:second", "A:independent"]);

		trace.length = 0;
		transport.ipc.removeListener("event", listenerA);
		transport.ipc.removeListener("event", listenerA);
		native.emit("event", "third");
		native.emit("other", "still-active");
		expect(trace).toEqual(["B:third", "A:still-active"]);

		trace.length = 0;
		transport.ipc.removeListener("event", listenerB);
		transport.ipc.removeListener("other", listenerA);
		native.emit("event", "ignored");
		native.emit("other", "ignored");
		expect(trace).toEqual([]);
	});
});
