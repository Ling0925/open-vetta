// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApp } from "./App.js";

const SNAPSHOT = {
	generation: "generation-1",
	cursor: 1,
	projects: [{ path: "C:/workspace/demo", name: "demo" }],
	archivedProjects: [],
};

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("WebApp", () => {
	it("pairs the browser and renders the read-only project snapshot", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(401, { error: { code: "WEB_ACCESS_UNAUTHORIZED" } });
			if (path === "/api/pair") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);

		const code = await screen.findByLabelText("Pairing code");
		await user.type(code, "pair-code");
		await user.click(screen.getByRole("button", { name: "Connect" }));
		await waitFor(() => expect(screen.getByText("demo")).toBeTruthy());
		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/pair"), expect.objectContaining({ credentials: "include" }));
		expect(screen.getByText("C:/workspace/demo")).toBeTruthy();
		// 配对失败时的引导文案不应该出现在成功路径上。
		expect(screen.queryByText("Web access was revoked. Pair this browser again.")).toBeNull();
	});

	it("keeps the last snapshot visible and reconnects automatically after a dropped watch", async () => {
		let watchCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") {
				watchCalls += 1;
				// 第一次观察直接断线，重连后的第二次返回新快照；此后继续挂起，
				// 与真实长轮询一样不会立即返回，避免测试里出现紧密重连循环。
				if (watchCalls === 1) throw new Error("network disconnected");
				if (watchCalls > 2) return pendingUntilAborted(init);
				return response(200, {
					changed: true,
					snapshot: { ...SNAPSHOT, cursor: 2, projects: [{ path: "C:/workspace/added", name: "added" }] },
				});
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		render(<WebApp />);

		await waitFor(() => expect(screen.getByText("demo")).toBeTruthy());
		// 断线期间保留旧数据，并明确说明正在重连，而不是要求用户手动刷新页面。
		await waitFor(() => expect(screen.getByText(/The connection was lost/)).toBeTruthy());
		expect(screen.getByText("C:/workspace/demo")).toBeTruthy();
		await waitFor(() => expect(screen.getByText("added")).toBeTruthy(), { timeout: 5_000 });
		expect(screen.getByText("Synced")).toBeTruthy();
		expect(screen.queryByText("Reconnecting automatically…")).toBeNull();
	});

	it("keeps the last project list visible while a manual refresh is pending", async () => {
		let snapshotCalls = 0;
		let finishRefresh: ((response: Response) => void) | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") {
				snapshotCalls += 1;
				return snapshotCalls === 1 ? response(200, SNAPSHOT) : await new Promise<Response>((resolve) => { finishRefresh = resolve; });
			}
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByText("demo");
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(snapshotCalls).toBe(2));
		expect(screen.getByText("demo")).toBeTruthy();
		finishRefresh?.(response(200, { ...SNAPSHOT, cursor: 2, projects: [{ path: "C:/workspace/new", name: "new" }] }));
		await screen.findByText("new");
	});

	it("stops retrying and asks for a new pairing when the grant is revoked", async () => {
		let snapshotCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") {
				snapshotCalls += 1;
				return response(401, { error: { code: "WEB_ACCESS_UNAUTHORIZED" } });
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		render(<WebApp />);

		await waitFor(() => expect(screen.getByText("Web access was revoked. Pair this browser again.")).toBeTruthy());
		// 授权失效不能靠重试恢复；界面直接回到配对表单，也不应继续打接口。
		await waitFor(() => expect(screen.getByLabelText("Pairing code")).toBeTruthy());
		expect(snapshotCalls).toBe(1);
	});

	it("keeps waiting for the host instead of claiming revocation or demanding a new code", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("network down");
		});
		render(<WebApp />);

		await screen.findByText("The connection was lost. Reconnecting automatically…");
		expect(screen.getByText(/Checking this browser's access/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
		expect(screen.queryByLabelText("Pairing code")).toBeNull();
		expect(screen.queryByText("Web access was revoked. Pair this browser again.")).toBeNull();
	});

	it("retries bootstrap immediately when the user asks and only shows pairing after a 401", async () => {
		let bootstrapCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") {
				bootstrapCalls += 1;
				if (bootstrapCalls === 1) throw new Error("network disconnected");
				return response(401, { error: { code: "WEB_ACCESS_UNAUTHORIZED" } });
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByText("The connection was lost. Reconnecting automatically…");
		await user.click(screen.getByRole("button", { name: "Retry now" }));
		await screen.findByLabelText("Pairing code");
		expect(bootstrapCalls).toBe(2);
	});

	it("waits for sign-out confirmation and treats an already revoked grant as signed out", async () => {
		let finishLogout: ((response: Response) => void) | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			if (path === "/api/session/logout") return await new Promise<Response>((resolve) => { finishLogout = resolve; });
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByText("demo");
		await user.click(screen.getByRole("button", { name: "Sign out of web access" }));
		expect(screen.getByRole("button", { name: "Signing out…" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("demo")).toBeTruthy();
		finishLogout?.(response(401, { error: { code: "WEB_ACCESS_UNAUTHORIZED" } }));
		await screen.findByLabelText("Pairing code");
		await screen.findByText("Web access was revoked. Pair this browser again.");
	});
	it("automatically restores an existing browser session after bootstrap loses the connection", async () => {
		let bootstrapCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") {
				bootstrapCalls += 1;
				if (bootstrapCalls === 1) throw new Error("network disconnected");
				return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			}
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			throw new Error(`Unexpected request: ${path}`);
		});
		render(<WebApp />);

		await screen.findByText("The connection was lost. Reconnecting automatically…");
		expect(screen.queryByLabelText("Pairing code")).toBeNull();
		await waitFor(() => expect(screen.getByText("demo")).toBeTruthy(), { timeout: 5_000 });
		expect(bootstrapCalls).toBe(2);
	});

	it("keeps the session visible when sign-out cannot be confirmed, then lets the user retry", async () => {
		let logoutCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			if (path === "/api/session/logout") {
				logoutCalls += 1;
				if (logoutCalls === 1) throw new Error("network disconnected");
				return response(200, { loggedOut: true });
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByText("demo");

		await user.click(screen.getByRole("button", { name: "Sign out of web access" }));
		await screen.findByText("Could not confirm sign-out. This browser may still have access; try again or revoke it from Desktop.");
		expect(screen.getByText("demo")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Sign out of web access" }));
		await screen.findByLabelText("Pairing code");
		expect(logoutCalls).toBe(2);
	});

	it("does not claim sign-out when the host returns success without confirming revocation", async () => {
		let logoutCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") return response(200, SNAPSHOT);
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			if (path === "/api/session/logout") {
				logoutCalls += 1;
				return response(200, { loggedOut: logoutCalls > 1 });
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByText("demo");
		await user.click(screen.getByRole("button", { name: "Sign out of web access" }));
		await screen.findByRole("alert");
		expect(screen.getByText("demo")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Sign out of web access" }));
		await screen.findByLabelText("Pairing code");
		expect(logoutCalls).toBe(2);
	});

	it("can pair again after a revoked project request without discarding the new authorization", async () => {
		let snapshotCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const path = new URL(String(input), "https://web.test").pathname;
			if (path === "/api/session/bootstrap") return response(200, { csrf: "csrf-1", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/pair") return response(200, { csrf: "csrf-2", expiresAt: 999, webOrigin: "https://web.test" });
			if (path === "/api/projects/snapshot") {
				snapshotCalls += 1;
				return snapshotCalls === 1 ? response(401, { error: { code: "WEB_ACCESS_UNAUTHORIZED" } }) : response(200, SNAPSHOT);
			}
			if (path === "/api/projects/watch") return pendingUntilAborted(init);
			throw new Error(`Unexpected request: ${path}`);
		});
		const user = userEvent.setup();
		render(<WebApp />);
		await screen.findByLabelText("Pairing code");
		await user.type(screen.getByLabelText("Pairing code"), "new-code");
		await user.click(screen.getByRole("button", { name: "Connect" }));
		await screen.findByText("demo");
		expect(snapshotCalls).toBe(2);
	});
});

function response(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** 长轮询：只在请求被取消时结束，模拟「没有项目变化就一直挂着」。 */
function pendingUntilAborted(init: RequestInit | undefined): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
	});
}
