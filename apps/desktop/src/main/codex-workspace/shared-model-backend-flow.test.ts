import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createSharedModelWorkspaceBackend } from "./shared-model-backend.js";
import { boundary } from "./shared-model-test-boundary.js";

vi.mock("@vetta/runtime-node/codex-app-server", async importOriginal => {
	const actual = await importOriginal<typeof import("@vetta/runtime-node/codex-app-server")>();
	const fixture = await import("./shared-model-test-boundary.js");
	return { ...actual, CodexRuntimeHostBackend: fixture.CodexRuntimeHostBackend, CodexHostSessionCatalog: fixture.CodexHostSessionCatalog };
});
vi.mock("@vetta/runtime-node/conversation", async () => ({
	FileConversationOwnershipManager: (await import("./shared-model-test-boundary.js")).FileConversationOwnershipManager,
}));
vi.mock("./model-source-host.js", async () => ({
	createDesktopCodexModelSource: (await import("./shared-model-test-boundary.js")).createDesktopCodexModelSource,
}));

function create() {
	boundary.reset();
	return createSharedModelWorkspaceBackend("/fixture/index", {
		executable: "/fixture/codex", expectedVersion: "0.0.0-test", cwd: "/fixture/workspace",
		codexHome: "/fixture/home", sandbox: "read-only", vettaModelKey: "gateway/model",
	}, async () => "decline");
}
function releaseRead() { boundary.paused = false; boundary.released.resolve(); }

describe("actual shared-model backend admission and cleanup", () => {
	it("stopping during configuration lookup never dispatches the old instruction after lookup completes", async () => {
		const backend = create();
		try {
			const session = await backend.open();
			boundary.paused = true; const work = session.prompt("cancel this"); await boundary.entered.promise;
			await session.stop(); releaseRead();
			assert.deepEqual(await work, { status: "cancelled" });
			assert.equal(boundary.dispatched, 0);
			assert.deepEqual(await session.prompt("next instruction"), { status: "completed" });
			assert.equal(boundary.dispatched, 1);
			await session.close();
			const resumed = await backend.open("session");
			assert.deepEqual(await resumed.prompt("after reopen"), { status: "completed" });
		} finally { releaseRead(); await backend.close(); }
	});

	it("closing a session cancels credential preflight rather than starting an orphan task", async () => {
		const backend = create();
		try {
			const session = await backend.open();
			boundary.paused = true; const work = session.prompt("cancel this"); await boundary.entered.promise;
			const handled = work.then(value => value, error => ({ rejected: String(error) }));
			await session.close(); releaseRead();
			assert.deepEqual(await handled, { status: "cancelled" });
			assert.equal(boundary.dispatched, 0);
			assert.equal(boundary.disposals, 1);
		} finally { releaseRead(); await backend.close(); }
	});

	it("backend disposal cancels preflight even when the view did not close its session first", async () => {
		const backend = create();
		try {
			const session = await backend.open();
			boundary.paused = true; const work = session.prompt("cancel this"); await boundary.entered.promise;
			const handled = work.then(value => value, error => ({ rejected: String(error) }));
			await backend.close(); releaseRead();
			assert.deepEqual(await handled, { status: "cancelled" });
			assert.equal(boundary.dispatched, 0);
		} finally { releaseRead(); await backend.close(); }
	});

	it("a failed startup rollback stays a cleanup failure instead of letting dispose claim success", async () => {
		const backend = create(); boundary.failOpen = true; boundary.failDispose = true;
		await assert.rejects(backend.open(), { code: "CLEANUP_UNCONFIRMED" });
		const close = backend.close();
		await assert.rejects(close, { code: "CLEANUP_UNCONFIRMED" });
		assert.equal(backend.close(), close);
		await assert.rejects(backend.open(), { code: "CLOSED" });
	});

	it("a failed session cleanup retains ownership and refuses a replacement session", async () => {
		const backend = create();
		const session = await backend.open(); boundary.failDispose = true;
		const close = session.close(); await assert.rejects(close, { code: "CLEANUP_UNCONFIRMED" });
		assert.equal(session.close(), close);
		await assert.rejects(backend.open(), { code: "BUSY" });
		await assert.rejects(backend.close(), { code: "CLEANUP_UNCONFIRMED" });
		assert.equal(boundary.disposals, 1);
	});
});
