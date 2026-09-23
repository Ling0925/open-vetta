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

	it("keeps pairing guidance when the host is unreachable instead of claiming revocation", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("network down");
		});
		render(<WebApp />);

		await waitFor(() => expect(screen.getByText("The connection was lost.")).toBeTruthy());
		expect(screen.queryByText("Web access was revoked. Pair this browser again.")).toBeNull();
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
