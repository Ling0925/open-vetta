// @vitest-environment jsdom

import { expect, it, vi } from "vitest";
import type { DesktopApi } from "./api.js";
import type { ProjectListSnapshot } from "./api-types/project.js";

const expose = vi.hoisted(() => vi.fn<(name: string, api: DesktopApi) => void>());
const invoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock("@sentry/electron/preload-namespaced", () => ({ hookupIpc: vi.fn() }));
vi.mock("@sentry/electron/renderer", () => ({ init: vi.fn() }));
vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: expose },
	ipcRenderer: { on: vi.fn(), send: vi.fn(), sendSync: vi.fn(() => "en"), invoke, removeListener: vi.fn() },
	webUtils: { getPathForFile: vi.fn() },
}));

it("exposes the Desktop bridge without Agent configuration or diagnostic APIs", async () => {
	await import("./index.js");
	const [name, api] = expose.mock.calls[0]!;
	expect(name).toBe("vetta");
	expect(api).not.toHaveProperty("agentConfiguration");
	expect(api).not.toHaveProperty("agentTraces");
	expect(api.session.create).toBeTypeOf("function");

	invoke.mockClear();
	expect(() => api.project.list()).toThrow("Host API access denied");
	expect(() => Reflect.apply(api.project.list, api.project, ["wrong-token"])).toThrow("Host API access denied");
	expect(invoke).not.toHaveBeenCalled();

	const token = api.hostAccess.claim();
	expect(token).toBeTypeOf("string");
	expect(() => api.hostAccess.claim()).toThrow("already been claimed");
	const snapshot: ProjectListSnapshot = {
		workspacePath: "C:/workspace",
		projects: [{ path: "C:/workspace/project" }],
		archivedProjects: [],
	};
	invoke.mockResolvedValueOnce(snapshot);
	await expect(Reflect.apply(api.project.list, api.project, [token])).resolves.toEqual(snapshot);
	expect(invoke).toHaveBeenCalledTimes(1);
	expect(invoke).toHaveBeenCalledWith("vetta:projects:list");
	expect(api.session.prompt).toBeTypeOf("function");
});
