// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAccessState } from "../../../../shared/web-access.js";
import { WebAccessSettings } from "./WebAccessSettings.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values?.time ? `:${values.time}` : ""}` }),
}));

const getState = vi.fn();
const configure = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
const pair = vi.fn();
const revoke = vi.fn();

const CONFIG = { origin: "https://web.test", port: 45821 };
/** 设置页每 2 秒轮询一次；等待授权出现要跨过这个周期。 */
const POLL_WAIT = { timeout: 5_000 };

/** 管理服务端的权威状态；测试通过改这个对象模拟「另一端完成了配对/撤销」。 */
let serverState: WebAccessState;

beforeEach(() => {
	vi.clearAllMocks();
	serverState = { status: "disabled", generation: 0, grants: [] };
	getState.mockImplementation(async () => serverState);
	configure.mockResolvedValue({ status: "disabled", generation: 1, config: CONFIG, grants: [] });
	enable.mockResolvedValue({ status: "enabled", generation: 2, config: CONFIG, grants: [] });
	disable.mockResolvedValue({ status: "disabled", generation: 3, config: CONFIG, grants: [] });
	pair.mockResolvedValue({ webUrl: "https://web.test/", code: "pair-code", expiresAt: 10_000 });
	revoke.mockImplementation(async () => {
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [] };
		return serverState;
	});
	(window as unknown as { vetta: { webAccess: unknown } }).vetta = {
		webAccess: { getState, configure, enable, disable, pair, revoke },
	};
});

afterEach(() => {
	cleanup();
});

describe("WebAccessSettings", () => {
	it("saves the local config, enables the service, and generates a one-time code", async () => {
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());

		await user.type(screen.getByLabelText("webAccess.originLabel"), "https://web.test");
		await user.click(screen.getByRole("button", { name: "webAccess.save" }));
		expect(configure).toHaveBeenCalledWith({ origin: "https://web.test", port: 45821 });

		await user.click(screen.getByRole("switch", { name: "webAccess.enable" }));
		expect(enable).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.getByText("webAccess.status.enabled")).toBeTruthy());

		await user.click(screen.getByRole("button", { name: "webAccess.pair" }));
		await waitFor(() => expect(screen.getByText("pair-code")).toBeTruthy());
		expect(pair).toHaveBeenCalledOnce();
	});

	it("picks up a browser that paired elsewhere and drops it after revocation", async () => {
		const grant = { id: "grant-1", createdAt: 1_000, expiresAt: 9_999 };
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [] };
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());
		expect(screen.queryByText("grant-1")).toBeNull();

		// 浏览器在另一个窗口完成配对：本页只能靠状态刷新得知，无需用户重开设置页。
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [grant] };
		await waitFor(() => expect(screen.getByText("grant-1")).toBeTruthy(), POLL_WAIT);

		await user.click(screen.getByRole("button", { name: "webAccess.revoke" }));
		await waitFor(() => expect(revoke).toHaveBeenCalledWith("grant-1"));
		await waitFor(() => expect(screen.getByText("webAccess.noGrants")).toBeTruthy());
	});

	it("keeps a failed operation's message and the user's draft instead of clearing them on the next refresh", async () => {
		serverState = { status: "disabled", generation: 0, grants: [] };
		configure.mockRejectedValueOnce(new Error("Web access origin must be a valid HTTPS origin"));
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());

		await user.type(screen.getByLabelText("webAccess.originLabel"), "https://web.test");
		await user.click(screen.getByRole("button", { name: "webAccess.save" }));
		await waitFor(() => expect(screen.getByText("Web access origin must be a valid HTTPS origin")).toBeTruthy());

		// 后续轮询成功且没有 error 字段，用户的输入与错误提示都不该被抹掉。
		await waitFor(() => expect(getState.mock.calls.length).toBeGreaterThan(1), POLL_WAIT);
		expect(screen.getByText("Web access origin must be a valid HTTPS origin")).toBeTruthy();
		expect((screen.getByLabelText("webAccess.originLabel") as HTMLInputElement).value).toBe("https://web.test");
	});
});
