import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CodexWorkspaceClient } from "./workspace-client.js";
import type { CodexWorkspaceSnapshot, DesktopCodexWorkspaceApi, CodexWorkspaceReply, CodexWorkspaceCommand } from "../../../shared/codex-workspace.js";
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const snapshot = (revision: number): CodexWorkspaceSnapshot => ({ instanceId: "main", revision, phase: "ready", rows: [], hasEarlierRows: false, approvals: [], sessions: [] });
function fixture() {
	let attaches = 0; let notice = () => { }; const calls: CodexWorkspaceCommand[] = [];
	const paint = deferred<void>(); const scheduled: (() => void)[] = [];
	let respond = async (_action: CodexWorkspaceCommand): Promise<CodexWorkspaceReply> => ({ ok: true, snapshot: snapshot(2) });
	const api: DesktopCodexWorkspaceApi = {
		attach: async () => { attaches++; return { token: "token", snapshot: snapshot(1) }; },
		command: async (_token, action) => { calls.push(action); return respond(action); },
		onChanged: listener => { notice = () => listener({ instanceId: "main", revision: 2 }); return () => { notice = () => { }; }; }
	};
	const client = new CodexWorkspaceClient(api, () => paint.promise, callback => scheduled.push(callback));
	return {
		client, paint, calls, attaches: () => attaches, notice: () => notice(), flush: () => scheduled.splice(0).forEach(f => f()),
		respond: (fn: typeof respond) => { respond = fn; }
	};
}
async function drain() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
describe("Codex preview view lifecycle", () => {
	it("shows the loading shell before performing any IPC", async () => {
		const f = fixture(); const start = f.client.start(); assert.equal(f.client.read().connection, "loading");
		assert.equal(f.attaches(), 0); f.paint.resolve(); await start; assert.equal(f.attaches(), 1); f.client.dispose();
	});
	it("does not start secondary work after the view unmounts during paint", async () => {
		const f = fixture(); const start = f.client.start(); f.client.dispose(); f.paint.resolve(); await start; assert.equal(f.attaches(), 0);
	});
	it("coalesces many invalidations into one snapshot request per scheduled update", async () => {
		const f = fixture(); f.paint.resolve(); await f.client.start();
		for (let i = 0; i < 100; i++) f.notice();
		f.flush(); await drain(); assert.equal(f.calls.filter(c => c.type === "snapshot").length, 1); f.client.dispose();
	});
	it("does not let a late snapshot replace a newer command result", async () => {
		const f = fixture(); f.paint.resolve(); await f.client.start();
		const old = deferred<CodexWorkspaceReply>();
		f.respond(async action => action.type === "snapshot" ? old.promise : { ok: true, snapshot: snapshot(5) });
		f.flush(); await drain(); await f.client.run({ type: "open" });
		old.resolve({ ok: true, snapshot: snapshot(2) }); await drain();
		assert.equal(f.client.read().snapshot?.revision, 5); f.client.dispose();
	});
	it("preserves the existing snapshot and never automatically retries an uncertain mutation", async () => {
		const f = fixture(); f.paint.resolve(); await f.client.start();
		f.respond(async () => { throw new Error("connection closed"); });
		assert.deepEqual(await f.client.run({ type: "send", sessionId: "s", inputId: "i", text: "work" }), { ok: false, code: "CONNECTION_LOST" });
		assert.equal(f.calls.filter(c => c.type === "send").length, 1); assert.equal(f.client.read().snapshot?.revision, 1); f.client.dispose();
	});
	it("detaches the view lease and removes event listeners on cleanup", async () => {
		const f = fixture(); f.paint.resolve(); await f.client.start(); f.client.dispose(); f.notice(); f.flush(); await drain();
		assert.equal(f.calls.filter(c => c.type === "detach").length, 1);
		assert.deepEqual(await f.client.run({ type: "close" }), { ok: false, code: "VIEW_EXPIRED" });
	});
	it("a close cancels an open still waiting behind the paint barrier", async () => {
		let release!: () => void; let wait = false; const commands: string[] = [];
		const api: DesktopCodexWorkspaceApi = {
			attach: async () => ({ token: "view", snapshot: snapshot(1) }),
			command: async (_token, action) => { commands.push(action.type); return { ok: true }; }, onChanged: () => () => { }
		};
		const client = new CodexWorkspaceClient(api, () => wait ? new Promise<void>(r => { release = r; }) : Promise.resolve(), () => { });
		await client.start(); wait = true; const open = client.run({ type: "open" });
		await client.run({ type: "close" }); release();
		assert.deepEqual(await open, { ok: false, code: "CANCELLED" }); assert.equal(commands.includes("open"), false); client.dispose();
	});
	it("does not overlap snapshot requests when another notice arrives during a read", async () => {
		const f = fixture(); f.paint.resolve(); await f.client.start(); const gate = deferred<CodexWorkspaceReply>();
		f.respond(() => gate.promise); f.flush(); await drain(); f.notice(); f.notice(); f.flush();
		assert.equal(f.calls.filter(c => c.type === "snapshot").length, 1);
		gate.resolve({ ok: true, snapshot: snapshot(2) }); await drain(); f.flush(); await drain();
		assert.equal(f.calls.filter(c => c.type === "snapshot").length, 2); f.client.dispose();
	});

});
