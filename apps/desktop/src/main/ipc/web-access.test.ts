import { describe, expect, it, vi } from "vitest";
import { WEB_ACCESS_CHANNELS } from "../../shared/web-access.js";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, handler);
		}),
		removeHandler: vi.fn(),
	},
}));

const { registerWebAccessIpc } = await import("./web-access.js");

describe("registerWebAccessIpc", () => {
	it("only accepts the registered top-level main window sender", async () => {
		const service = {
			getState: vi.fn(() => ({ status: "disabled", generation: 0, grants: [] })),
			configure: vi.fn(),
			enable: vi.fn(),
			disable: vi.fn(),
			pair: vi.fn(),
			revoke: vi.fn(),
		};
		const mainFrame: { top?: unknown } = {};
		mainFrame.top = mainFrame;
		let currentUrl = "file:///app/renderer/index.html";
		const webContents = {
			id: 7,
			mainFrame,
			isDestroyed: () => false,
			getURL: () => currentUrl,
		};
		const teardown = registerWebAccessIpc(webContents as never, service as never);
		const getState = handlers.get(WEB_ACCESS_CHANNELS.GET_STATE);
		if (!getState) throw new Error("getState handler was not registered");

		expect(() => getState({ sender: { id: 8 }, senderFrame: null })).toThrow("Unauthorized");
		const childFrame = {};
		expect(() => getState({ sender: webContents, senderFrame: { top: childFrame } })).toThrow("Unauthorized");
		expect(() => getState({ sender: webContents, senderFrame: null })).toThrow("Unauthorized");
		currentUrl = "https://evil.test/";
		expect(() => getState({ sender: webContents, senderFrame: mainFrame })).toThrow("Unauthorized");
		currentUrl = "file:///app/renderer/index.html";
		expect(getState({ sender: webContents, senderFrame: mainFrame })).toEqual({
			status: "disabled",
			generation: 0,
			grants: [],
		});
		teardown();
	});
});
