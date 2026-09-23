import type { SessionEvent } from "@vetta/runtime-core";
import { describe, expect, it, vi } from "vitest";
import type { HostTransport, HostTransportEventListener } from "../shared/host-transport.js";
import { PERSIST_IMAGE_FILES_CHANNEL } from "../shared/image-cache.js";
import { TERMINAL_CHANNELS, type TerminalEventEnvelope } from "../shared/terminal-ipc.js";
import type { DesktopConfigData } from "./api-types/config.js";
import type { ProjectListSnapshot } from "./api-types/project.js";
import { createRawDesktopApi } from "./raw-api.js";

const projectSnapshot: ProjectListSnapshot = {
	workspacePath: "C:/workspace",
	projects: [{ path: "C:/workspace/project" }],
	archivedProjects: [],
};
const configuration: DesktopConfigData = {
	workspacePath: projectSnapshot.workspacePath,
	projects: [...projectSnapshot.projects],
	archivedProjects: [],
	defaultExecutionMode: "sandbox",
};

class FakeHostTransport implements HostTransport {
	readonly calls: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
	private readonly listeners = new Map<string, Set<HostTransportEventListener>>();

	async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		this.calls.push({ channel, args });
		if (channel === "vetta:session:subscribe") {
			return { subscriptionId: "session-subscription", initial: sessionEvent("event-initial", "initial") } as T;
		}
		if (channel === "vetta:projects:list") return projectSnapshot as T;
		if (channel === "vetta:config:get") return configuration as T;
		if (channel === TERMINAL_CHANNELS.OPEN)
			return { terminalId: "terminal-1", backend: "local", replay: "", replayTruncated: false } as T;
		return undefined as T;
	}

	send(_channel: string, ..._args: unknown[]): void {}
	sendSync<T>(_channel: string, ..._args: unknown[]): T {
		return undefined as T;
	}

	on(channel: string, listener: HostTransportEventListener): void {
		const listeners = this.listeners.get(channel) ?? new Set<HostTransportEventListener>();
		listeners.add(listener);
		this.listeners.set(channel, listeners);
	}

	removeListener(channel: string, listener: HostTransportEventListener): void {
		this.listeners.get(channel)?.delete(listener);
	}

	emit(channel: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(channel) ?? []) listener({}, ...args);
	}
}

describe("createRawDesktopApi", () => {
	it("assembles session, project, config and terminal APIs over one transport", async () => {
		const transport = new FakeHostTransport();
		const api = createRawDesktopApi({
			ipc: transport,
			filePath: { getPathForFile: vi.fn(() => "") },
		});

		expect(api).not.toHaveProperty("hostAccess");

		const sessionEvents: SessionEvent[] = [];
		const unsubscribeSession = await api.session.subscribe("session-1", (event) => sessionEvents.push(event));
		transport.emit("vetta:session:event", "session-subscription", sessionEvent("event-stream", "streamed"));
		await api.session.prompt("session-1", { text: "hello" });
		await api.session.abort("session-1");
		const projectList = await api.project.list();
		const config = await api.config.get();

		const terminalEvents: TerminalEventEnvelope[] = [];
		const terminal = await api.terminal.open({ cwd: "C:/workspace", cols: 80, rows: 24 });
		await api.terminal.write(terminal.terminalId, "ls");
		await api.terminal.resize(terminal.terminalId, 100, 30);
		const unsubscribeTerminal = api.terminal.onEvent((event) => terminalEvents.push(event));
		const terminalEvent: TerminalEventEnvelope = {
			terminalId: "terminal-1",
			event: { kind: "data", data: "hello" },
		};
		transport.emit(TERMINAL_CHANNELS.EVENT, terminalEvent);
		unsubscribeTerminal();
		await api.terminal.close(terminal.terminalId);
		transport.emit(TERMINAL_CHANNELS.EVENT, { ...terminalEvent, event: { kind: "data", data: "ignored" } });

		unsubscribeSession();
		transport.emit("vetta:session:event", "session-subscription", sessionEvent("event-late", "ignored"));

		expect(projectList).toEqual({
			workspacePath: "C:/workspace",
			projects: [{ path: "C:/workspace/project" }],
			archivedProjects: [],
		});
		expect(config).toEqual({
			workspacePath: "C:/workspace",
			projects: [{ path: "C:/workspace/project" }],
			archivedProjects: [],
			defaultExecutionMode: "sandbox",
		});
		expect(transport.calls).toContainEqual({
			channel: "vetta:session:prompt",
			args: ["session-1", { text: "hello" }, undefined],
		});
		expect(transport.calls).toContainEqual({ channel: "vetta:session:abort", args: ["session-1"] });
		expect(sessionEvents).toEqual([
			expect.objectContaining({ type: "message.delta", delta: "initial" }),
			expect.objectContaining({ type: "message.delta", delta: "streamed" }),
		]);
		expect(terminalEvents).toEqual([terminalEvent]);
		expect(transport.calls.map(({ channel }) => channel)).toEqual([
			"vetta:session:subscribe",
			"vetta:session:prompt",
			"vetta:session:abort",
			"vetta:projects:list",
			"vetta:config:get",
			"vetta:terminal:open",
			"vetta:terminal:write",
			"vetta:terminal:resize",
			"vetta:terminal:close",
			"vetta:session:unsubscribe",
		]);
	});

	it("keeps the file-path and binary fallback behavior at the adapter boundary", async () => {
		const transport = new FakeHostTransport();
		const virtualData = Uint8Array.from([1, 2, 3]).buffer;
		const diskFile = new File(["disk-image"], "disk.png", { type: "image/png" });
		const virtualFile = new File([virtualData], "virtual.webp", { type: "image/webp" });
		vi.spyOn(diskFile, "arrayBuffer");
		vi.spyOn(virtualFile, "arrayBuffer");
		const getPathForFile = vi.fn((file: File) => (file === diskFile ? "C:/images/disk.png" : ""));
		const api = createRawDesktopApi({
			ipc: transport,
			filePath: { getPathForFile },
		});

		await api.dialog.persistImageFiles("session-1", [diskFile, virtualFile]);

		expect(getPathForFile).toHaveBeenCalledWith(diskFile);
		expect(getPathForFile).toHaveBeenCalledWith(virtualFile);
		expect(diskFile.arrayBuffer).not.toHaveBeenCalled();
		expect(virtualFile.arrayBuffer).toHaveBeenCalledOnce();
		expect(transport.calls.at(-1)).toEqual({
			channel: PERSIST_IMAGE_FILES_CHANNEL,
			args: [
				"session-1",
				[
					{
						id: expect.any(String),
						mimeType: "image/png",
						source: { kind: "file-path", path: "C:/images/disk.png" },
					},
					{
						id: expect.any(String),
						mimeType: "image/webp",
						source: { kind: "bytes", data: virtualData },
					},
				],
			],
		});
	});
});

function sessionEvent(eventId: string, delta: string): Extract<SessionEvent, { type: "message.delta" }> {
	return {
		schemaVersion: 1,
		channel: "runtime",
		sessionId: "session-1",
		eventId,
		timestamp: 1,
		source: "runtime-core",
		sequence: 1,
		type: "message.delta",
		delta,
	};
}
