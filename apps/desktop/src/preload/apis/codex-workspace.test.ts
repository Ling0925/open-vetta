import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createCodexWorkspaceApi } from "./codex-workspace.js";
import { CODEX_WORKSPACE_CHANNELS } from "../../shared/codex-workspace.js";
import type { HostTransport, HostTransportEventListener } from "../../shared/host-transport.js";
function fixture() {
	const sent: unknown[][] = []; const listeners = new Map<string, HostTransportEventListener>();
	const ipc: HostTransport = {
		invoke: async <T>(...args: unknown[]) => { sent.push(args); return { ok: true } as T; },
		send: () => { }, sendSync: () => { throw new Error("not supported"); },
		on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: channel => { listeners.delete(channel); }
	};
	return { sent, listeners, api: createCodexWorkspaceApi(ipc).codexWorkspace };
}
describe("Codex preload bridge", () => {
	it("uses the shared channels and forwards the view lease separately from the typed command", async () => {
		const f = fixture(); await f.api.attach(); await f.api.command("view-token", { type: "stop", sessionId: "s", inputId: "i" });
		assert.deepEqual(f.sent, [[CODEX_WORKSPACE_CHANNELS.ATTACH], [CODEX_WORKSPACE_CHANNELS.COMMAND, "view-token", { type: "stop", sessionId: "s", inputId: "i" }]]);
	});
	it("subscribes without exposing the Electron event and removes listeners on cleanup", () => {
		const f = fixture(); let observed: unknown; const remove = f.api.onChanged(notice => { observed = notice; });
		f.listeners.get(CODEX_WORKSPACE_CHANNELS.CHANGED)?.({ privateEvent: true }, { instanceId: "one", revision: 2 });
		assert.deepEqual(observed, { instanceId: "one", revision: 2 }); remove(); assert.equal(f.listeners.size, 0);
	});
});
