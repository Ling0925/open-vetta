import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CodexWorkspaceController, type WorkspaceBackend, type WorkspaceSession } from "./controller.js";
import type { WorkspaceApprovalRequest } from "./approvals.js";
import type { CodexWorkspaceCommand, CodexWorkspaceProfile } from "../../shared/codex-workspace.js";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}
const profile: CodexWorkspaceProfile = { executable: "/trusted/codex", expectedVersion: "1.0.0", codexHome: "/private/codex", cwd: "/workspace", sandbox: "read-only" };
async function fixture() {
	const done = deferred<{ status: "completed" | "cancelled" | "failed" }>();
	const started = deferred<void>();
	const opening = deferred<void>(); opening.resolve();
	let calls = 0; let stops = 0; let closes = 0; let opens = 0; let recovery = false;
	let approve!: (request: WorkspaceApprovalRequest) => Promise<"accept" | "decline" | "cancel">;
	const handle: WorkspaceSession = {
		id: "session", snapshot: () => ({ rows: [], hasEarlierRows: false, recovery }),
		subscribe: () => () => { }, prompt: async () => { calls++; started.resolve(); return done.promise; },
		stop: async () => { stops++; done.resolve({ status: "cancelled" }); },
		close: async () => { closes++; done.resolve({ status: "cancelled" }); }
	};
	let gate: Promise<void> = opening.promise;
	const backend: WorkspaceBackend = {
		list: async () => [{ id: "saved", name: "Saved conversation", modifiedAt: 1 }],
		open: async () => { opens++; await gate; return handle; }, close: async () => { }
	};
	const controller = new CodexWorkspaceController({
		readProfile: async () => profile, writeProfile: async () => { },
		confirmProfile: async () => true, choosePath: async () => undefined,
		createBackend: (_profile, approval) => { approve = approval; return backend; }
	});
	const view = await controller.attach();
	const command = (action: CodexWorkspaceCommand) => controller.execute(view.token, action);
	return {
		controller, view, command, handle, backend, done, started,
		counts: () => ({ calls, stops, closes, opens }), recovery: () => { recovery = true; },
		approve: (request: WorkspaceApprovalRequest) => approve(request), blockOpen: (promise: Promise<void>) => { gate = promise; }
	};
}
const send = { type: "send", sessionId: "session", inputId: "input-1", text: "work" } as const;
async function drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("Codex desktop command owner", () => {
	it("lists saved sessions on initial attach without starting a Codex process", async () => {
		const f = await fixture(); try { assert.equal(f.view.snapshot.sessions[0].id, "saved"); assert.equal(f.counts().opens, 0); }
		finally { await f.controller.dispose(); }
	});
	it("returns accepted input before completion and remains stoppable", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" });
			const reply = await f.command(send); assert.equal(reply.ok, true);
			await f.started.promise;
			const snapshot = await f.command({ type: "snapshot" }); assert.ok(snapshot.ok); assert.equal(snapshot.snapshot?.phase, "running");
			await f.command({ type: "stop", sessionId: "session", inputId: "input-1" });
			const stopped = await f.command({ type: "snapshot" }); assert.ok(stopped.ok); assert.equal(stopped.snapshot?.outcome, "cancelled");
			assert.equal(f.counts().stops, 1);
		} finally { await f.controller.dispose(); }
	});
	it("deduplicates retry of one input ID and rejects changed payload or simultaneous work", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send); await f.command(send);
			assert.deepEqual(await f.command({ ...send, text: "different" }), { ok: false, code: "INPUT_CONFLICT" });
			assert.deepEqual(await f.command({ ...send, inputId: "input-2" }), { ok: false, code: "BUSY" });
			assert.equal(f.counts().calls, 1);
		} finally { await f.controller.dispose(); }
	});
	it("does not allow a stale stop to affect the current input", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send);
			assert.deepEqual(await f.command({ type: "stop", sessionId: "session", inputId: "old" }), { ok: false, code: "TURN_MISMATCH" });
			assert.equal(f.counts().stops, 0);
		} finally { await f.controller.dispose(); }
	});
	it("rejects unknown operations and refuses silently dropping attachments or model overrides", async () => {
		const f = await fixture(); try {
			assert.deepEqual(await f.controller.execute(f.view.token, { ...send, images: ["image"] }), { ok: false, code: "INPUT" });
			assert.deepEqual(await f.controller.execute(f.view.token, { type: "rpc", method: "turn/start" }), { ok: false, code: "UNSUPPORTED" });
			assert.equal(f.counts().calls, 0);
		} finally { await f.controller.dispose(); }
	});
	it("page detachment cancels approval and invalidates its token", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send); await f.started.promise;
			const pending = f.approve({ method: "item/fileChange/requestApproval", params: { path: "file" }, signal: new AbortController().signal });
			const snapshot = await f.command({ type: "snapshot" }); assert.ok(snapshot.ok); assert.equal(snapshot.snapshot?.approvals.length, 1);
			await f.command({ type: "detach" }); assert.equal(await pending, "cancel");
			assert.deepEqual(await f.command({ type: "snapshot" }), { ok: false, code: "VIEW_EXPIRED" });
		} finally { await f.controller.dispose(); }
	});
	it("another attachment revokes the old view and its pending approvals", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send); await f.started.promise;
			const pending = f.approve({ method: "item/fileChange/requestApproval", params: {}, signal: new AbortController().signal });
			const next = await f.controller.attach(); assert.equal(await pending, "cancel");
			assert.notEqual(next.token, f.view.token);
			assert.deepEqual(await f.command({ type: "close" }), { ok: false, code: "VIEW_EXPIRED" });
		} finally { await f.controller.dispose(); }
	});
	it("never approves a request while the page has no owner", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send); await f.command({ type: "detach" });
			assert.equal(await f.approve({ method: "item/fileChange/requestApproval", params: {}, signal: new AbortController().signal }), "decline");
		} finally { await f.controller.dispose(); }
	});
	it("closes a late process when close wins during initialization", async () => {
		const f = await fixture(); const gate = deferred<void>(); f.blockOpen(gate.promise);
		try {
			const open = f.command({ type: "open" }); await drain();
			const close = f.command({ type: "close" }); await drain(); gate.resolve();
			assert.deepEqual(await open, { ok: false, code: "CANCELLED" }); assert.equal((await close).ok, true);
			assert.equal(f.counts().closes, 1);
			const snapshot = await f.command({ type: "snapshot" }); assert.ok(snapshot.ok); assert.equal(snapshot.snapshot?.sessionId, undefined);
		} finally { await f.controller.dispose(); }
	});
	it("rejects duplicate initialization without spawning a second process", async () => {
		const f = await fixture(); const gate = deferred<void>(); f.blockOpen(gate.promise);
		try {
			const open = f.command({ type: "open" }); await drain();
			assert.deepEqual(await f.command({ type: "open" }), { ok: false, code: "BUSY" });
			gate.resolve(); await open; assert.equal(f.counts().opens, 1);
		} finally { gate.resolve(); await f.controller.dispose(); }
	});
	it("does not replay failed or unknown work and requires explicit close/reopen", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" }); await f.command(send); await f.started.promise;
			f.recovery(); f.done.resolve({ status: "failed" }); await drain();
			const snapshot = await f.command({ type: "snapshot" }); assert.ok(snapshot.ok); assert.equal(snapshot.snapshot?.phase, "recovery");
			assert.deepEqual(await f.command({ ...send, inputId: "new" }), { ok: false, code: "BUSY" });
			assert.equal(f.counts().calls, 1);
		} finally { await f.controller.dispose(); }
	});
	it("requires native confirmation and blocks configuration changes while a session is open", async () => {
		const f = await fixture(); try {
			await f.command({ type: "open" });
			assert.deepEqual(await f.command({ type: "configure", profile }), { ok: false, code: "BUSY" });
		} finally { await f.controller.dispose(); }
	});
	it("disposal shares a promise, blocks new calls and closes active work", async () => {
		const f = await fixture(); await f.command({ type: "open" }); await f.command(send);
		const close = f.controller.dispose(); assert.equal(f.controller.dispose(), close); await close;
		assert.deepEqual(await f.command({ type: "open" }), { ok: false, code: "CLOSED" });
		assert.equal(f.counts().closes, 1);
	});
	it("revokes a late opening result if its originating view has detached", async () => {
		const f = await fixture(); const gate = deferred<void>(); f.blockOpen(gate.promise);
		try {
			const open = f.command({ type: "open" }); await drain(); await f.command({ type: "detach" }); gate.resolve();
			assert.deepEqual(await open, { ok: false, code: "CANCELLED" }); assert.equal(f.counts().closes, 1);
		} finally { gate.resolve(); await f.controller.dispose(); }
	});
	it("disposal waits for and closes a process created by an in-flight opening", async () => {
		const f = await fixture(); const gate = deferred<void>(); f.blockOpen(gate.promise);
		const open = f.command({ type: "open" }); await drain(); const closed = f.controller.dispose(); gate.resolve();
		await open; await closed; assert.equal(f.counts().closes, 1);
	});
	it("a declined native confirmation never changes persisted profile or starts a process", async () => {
		let writes = 0; let creates = 0;
		const controller = new CodexWorkspaceController({
			readProfile: async () => undefined, writeProfile: async () => { writes++; },
			confirmProfile: async () => false, choosePath: async () => undefined, createBackend: () => { creates++; throw new Error("must not launch"); }
		});
		try {
			const view = await controller.attach();
			assert.deepEqual(await controller.execute(view.token, { type: "configure", profile }), { ok: false, code: "CANCELLED" });
			assert.equal(writes, 0); assert.equal(creates, 0);
		} finally { await controller.dispose(); }
	});

	it("a committed profile remains authoritative when its view detaches during persistence", async () => {
		const writing = deferred<void>(); const saved = deferred<void>();
		let persisted: CodexWorkspaceProfile | undefined;
		let backends = 0;
		const next = { ...profile, expectedVersion: "2.0.0" };
		const controller = new CodexWorkspaceController({
			readProfile: async () => undefined,
			writeProfile: async value => { writing.resolve(); await saved.promise; persisted = value; },
			confirmProfile: async () => true, choosePath: async () => undefined,
			createBackend: () => { backends++; return { list: async () => [], open: async () => { throw new Error("unused"); }, close: async () => { } }; },
		});
		try {
			const original = await controller.attach();
			const configuring = controller.execute(original.token, { type: "configure", profile: next });
			await writing.promise;
			await controller.execute(original.token, { type: "detach" });
			saved.resolve();
			assert.deepEqual(await configuring, { ok: false, code: "VIEW_EXPIRED" });
			assert.deepEqual(persisted, next); assert.equal(backends, 0);
			const restored = await controller.attach();
			assert.deepEqual(restored.snapshot.profile, next); assert.equal(backends, 1);
		} finally { saved.resolve(); await controller.dispose(); }
	});
	it("detaching during post-open catalog loading closes the initialized session", async () => {
		const f = await fixture(); const loading = deferred<void>(); const release = deferred<void>();
		f.backend.list = async () => { loading.resolve(); await release.promise; return []; };
		try {
			const opening = f.command({ type: "open" }); await loading.promise;
			await f.command({ type: "detach" }); release.resolve();
			assert.deepEqual(await opening, { ok: false, code: "CANCELLED" });
			await drain();
			assert.equal(f.counts().closes, 1);
			const restored = await f.controller.attach();
			assert.equal(restored.snapshot.sessionId, undefined);
		} finally { release.resolve(); await f.controller.dispose(); }
	});

});
