import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { WebContents } from "electron";
import { CODEX_WORKSPACE_CHANNELS } from "../../shared/codex-workspace.js";
import { registerCodexWorkspaceIpc } from "./codex-workspace.js";
const f = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	attach: vi.fn(async () => ({ token: "view" })), command: vi.fn(async () => ({ ok: true })), teardown: vi.fn()
}));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (name: string, handler: (...args: unknown[]) => unknown) => f.handlers.set(name, handler),
		removeHandler: (name: string) => f.handlers.delete(name),
	}
}));
vi.mock("../codex-workspace/electron-service.js", () => ({ createDesktopCodexWorkspace: () => f }));
afterEach(() => { f.handlers.clear(); vi.clearAllMocks(); });
describe("Codex workspace IPC registration", () => {
	it("delegates sender validation and preserves token/command argument order", async () => {
		const cleanup = registerCodexWorkspaceIpc({} as WebContents); const sender = {};
		await f.handlers.get(CODEX_WORKSPACE_CHANNELS.ATTACH)?.(sender);
		const command = { type: "close" }; await f.handlers.get(CODEX_WORKSPACE_CHANNELS.COMMAND)?.(sender, "view", command);
		assert.deepEqual(f.attach.mock.calls[0], [sender]); assert.deepEqual(f.command.mock.calls[0], [sender, "view", command]);
		cleanup();
	});
	it("unregisters both channels and delegates resource teardown", () => {
		const cleanup = registerCodexWorkspaceIpc({} as WebContents); assert.equal(f.handlers.size, 2);
		cleanup(); assert.equal(f.handlers.size, 0); assert.equal(f.teardown.mock.calls.length, 1);
	});
});
