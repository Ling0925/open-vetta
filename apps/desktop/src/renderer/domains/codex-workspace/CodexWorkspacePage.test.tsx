// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "jotai";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import zh from "../../../shared/i18n/locales/zh/codex.json";
import type { CodexWorkspaceCommand, CodexWorkspaceSnapshot, DesktopCodexWorkspaceApi } from "../../../shared/codex-workspace";
import { CodexWorkspacePage } from "./CodexWorkspacePage";
const boundary = vi.hoisted(() => ({ paint: Promise.resolve<unknown>(undefined) }));
vi.mock("@shared/lib/committed-paint", () => ({ waitForCommittedPaint: () => boundary.paint }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => async () => { } }));
vi.mock("@shared/store/atoms", () => import("@shared/store/codex-workspace-atoms"));
let root: Root; let container: HTMLDivElement;
let snapshot: CodexWorkspaceSnapshot; let commands: CodexWorkspaceCommand[];
let api: DesktopCodexWorkspaceApi; let notify: () => void; let uncertain = false;
let original: PropertyDescriptor | undefined;
const language = i18next.createInstance();
beforeEach(async () => {
	vi.useFakeTimers(); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	await language.init({ initAsync: false, lng: "zh", fallbackLng: "zh", resources: { zh: { codex: zh } }, defaultNS: "codex" });
	boundary.paint = Promise.resolve(); commands = []; uncertain = false;
	snapshot = { instanceId: "main", revision: 1, phase: "ready", sessionId: "session", rows: [], hasEarlierRows: false, sessions: [], approvals: [] };
	api = {
		attach: vi.fn(async () => ({ token: "view", snapshot: structuredClone(snapshot) })),
		command: async (_token, command) => {
			commands.push(command);
			if (command.type === "send") {
				if (uncertain) throw new Error("transport unavailable");
				snapshot = { ...snapshot, revision: snapshot.revision + 1, phase: "running", activeInputId: command.inputId };
				return { ok: true, acceptedInputId: command.inputId, snapshot: structuredClone(snapshot) };
			}
			if (command.type === "stop") snapshot = { ...snapshot, revision: snapshot.revision + 1, phase: "ready", activeInputId: undefined, outcome: "cancelled" };
			if (command.type === "approval") snapshot = { ...snapshot, revision: snapshot.revision + 1, approvals: [] };
			return { ok: true, snapshot: structuredClone(snapshot) };
		}, onChanged: listener => { notify = () => listener({ instanceId: snapshot.instanceId, revision: snapshot.revision }); return () => { }; }
	};
	original = Object.getOwnPropertyDescriptor(window, "vetta");
	Object.defineProperty(window, "vetta", { configurable: true, value: { codexWorkspace: api } });
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount()); container.remove(); vi.clearAllTimers(); vi.useRealTimers();
	if (original) Object.defineProperty(window, "vetta", original); else Reflect.deleteProperty(window, "vetta");
});
async function mount() { await act(async () => { root.render(<Provider><I18nextProvider i18n={language}><CodexWorkspacePage /></I18nextProvider></Provider>); }); }
function button(text: string): HTMLButtonElement {
	const result = [...container.querySelectorAll("button")].find(element => element.textContent === text);
	assert.ok(result, `Missing button: ${text}`); return result;
}
async function input(text: string) {
	const textarea = container.querySelector("textarea"); assert.ok(textarea);
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return textarea;
}
describe("Codex preview UI and public preload boundary", () => {
	it("renders the shell before attaching and does not initialize before the paint barrier", async () => {
		let painted!: () => void; boundary.paint = new Promise(resolve => { painted = () => resolve(undefined); });
		await mount(); assert.match(container.textContent ?? "", /正在读取/); assert.equal(vi.mocked(api.attach).mock.calls.length, 0);
		await act(async () => { painted(); }); assert.equal(vi.mocked(api.attach).mock.calls.length, 1);
	});
	it("sends the typed draft and keeps Stop enabled while work is running", async () => {
		await mount(); const textarea = await input("检查此项目，不修改文件");
		await act(async () => button(zh.send).click());
		assert.equal(commands.filter(command => command.type === "send").length, 1);
		assert.equal(button(zh.stop).disabled, false); assert.equal(button(zh.send).disabled, true);
		await act(async () => button(zh.stop).click());
		assert.equal(textarea.value, "检查此项目，不修改文件"); assert.equal(commands.at(-1)?.type, "stop");
	});
	it("keeps input on uncertain delivery and never automatically sends it again", async () => {
		uncertain = true; await mount(); const textarea = await input("preserve this draft");
		await act(async () => button(zh.send).click());
		assert.equal(textarea.value, "preserve this draft"); assert.ok(container.querySelector('[role="alert"]'));
		assert.equal(commands.filter(command => command.type === "send").length, 1);
	});
	it("renders approval details as text and removes an expired approval before another action", async () => {
		snapshot = {
			...snapshot, phase: "running", activeInputId: "i", approvals: [{
				id: "approval", sessionId: "session", inputId: "i",
				kind: "command", details: '<img src="https://untrusted.invalid" onerror="evil()">', expiresAt: Date.now() + 50000
			}]
		};
		await mount(); assert.equal(container.querySelector("img"), null); assert.ok(button(zh.acceptOnce));
		snapshot = { ...snapshot, revision: 2, approvals: [] };
		await act(async () => { notify(); await vi.advanceTimersByTimeAsync(100); });
		assert.equal([...container.querySelectorAll("button")].some(element => element.textContent === zh.acceptOnce), false);
	});
});
