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
const LAN_CONFIG = { origin: "http://192.168.1.21:45821", port: 45821 };
/** 设置页每 2 秒轮询一次；等待授权出现要跨过这个周期。 */
const POLL_WAIT = { timeout: 5_000 };

/** 管理服务端的权威状态；测试通过改这个对象模拟「另一端完成了配对/撤销」。 */
let serverState: WebAccessState;

beforeEach(() => {
	vi.clearAllMocks();
	serverState = { status: "disabled", generation: 0, grants: [], lanAddresses: [] };
	getState.mockImplementation(async () => serverState);
	configure.mockResolvedValue({ status: "disabled", generation: 1, config: CONFIG, grants: [], lanAddresses: [] });
	enable.mockResolvedValue({ status: "enabled", generation: 2, config: CONFIG, grants: [], lanAddresses: [] });
	disable.mockResolvedValue({ status: "disabled", generation: 3, config: CONFIG, grants: [], lanAddresses: [] });
	pair.mockResolvedValue({ webUrl: "https://web.test/", code: "pair-code", expiresAt: 10_000 });
	revoke.mockImplementation(async () => {
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [], lanAddresses: [] };
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
	it("starts LAN access from the pairing action and shows a working local URL and code", async () => {
		serverState = { status: "disabled", generation: 0, grants: [], lanAddresses: ["192.168.1.21"] };
		configure.mockImplementation(async (config) => {
			serverState = { ...serverState, config, generation: 1 };
			return serverState;
		});
		enable.mockImplementation(async () => {
			serverState = { ...serverState, status: "enabled", generation: 2 };
			return serverState;
		});
		pair.mockResolvedValue({ webUrl: `${LAN_CONFIG.origin}/`, code: "pair-code", expiresAt: 10_000 });
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());
		await waitFor(() => expect(screen.getByRole("button", { name: "webAccess.pair" }).hasAttribute("disabled")).toBe(false));
		await user.click(screen.getByRole("button", { name: "webAccess.pair" }));
		await waitFor(() => expect(screen.getByText("pair-code")).toBeTruthy());
		expect(configure).toHaveBeenCalledWith(LAN_CONFIG);
		expect(enable).toHaveBeenCalledOnce();
		expect(pair).toHaveBeenCalledOnce();
		expect(screen.getByText(`${LAN_CONFIG.origin}/`)).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "webAccess.disable" }));
		await waitFor(() => expect(disable).toHaveBeenCalledOnce());
		expect(screen.queryByText("pair-code")).toBeNull();
	});

	it("uses the current LAN address rather than a stale address from a prior network", async () => {
		serverState = {
			status: "disabled",
			generation: 1,
			config: LAN_CONFIG,
			grants: [],
			lanAddresses: ["192.168.1.22"],
		};
		configure.mockImplementation(async (config) => {
			serverState = { ...serverState, config, generation: 2 };
			return serverState;
		});
		enable.mockImplementation(async () => {
			serverState = { ...serverState, status: "enabled", generation: 3 };
			return serverState;
		});
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(screen.getByText("http://192.168.1.22:45821")).toBeTruthy());
		await user.click(screen.getByRole("button", { name: "webAccess.pair" }));
		await waitFor(() => expect(pair).toHaveBeenCalledOnce());
		expect(configure).toHaveBeenCalledWith({ origin: "http://192.168.1.22:45821", port: 45821 });
	});

	it("keeps a trusted HTTPS proxy as an advanced option when no LAN address is available", async () => {
		configure.mockImplementation(async (config) => {
			serverState = { ...serverState, config, generation: 1 };
			return serverState;
		});
		enable.mockImplementation(async () => {
			serverState = { ...serverState, status: "enabled", generation: 2 };
			return serverState;
		});
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(screen.getByText("webAccess.noNetwork")).toBeTruthy());
		expect(screen.getByRole("button", { name: "webAccess.pair" }).hasAttribute("disabled")).toBe(true);
		await user.click(screen.getByText("webAccess.advanced"));
		await user.type(screen.getByLabelText("webAccess.originLabel"), CONFIG.origin);
		await user.click(screen.getByRole("button", { name: "webAccess.pair" }));
		await waitFor(() => expect(screen.getByText("pair-code")).toBeTruthy());
		expect(configure).toHaveBeenCalledWith(CONFIG);
		expect(enable).toHaveBeenCalledOnce();
	});
	it("picks up a browser that paired elsewhere and drops it after revocation", async () => {
		const grant = { id: "grant-1", createdAt: 1_000, expiresAt: 9_999 };
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [], lanAddresses: [] };
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());
		expect(screen.queryByText("grant-1")).toBeNull();

		// 浏览器在另一个窗口完成配对：本页只能靠状态刷新得知，无需用户重开设置页。
		serverState = { status: "enabled", generation: 2, config: CONFIG, grants: [grant], lanAddresses: [] };
		await waitFor(() => expect(screen.getByText("grant-1")).toBeTruthy(), POLL_WAIT);

		await user.click(screen.getByRole("button", { name: "webAccess.revoke" }));
		await waitFor(() => expect(revoke).toHaveBeenCalledWith("grant-1"));
		await waitFor(() => expect(screen.getByText("webAccess.noGrants")).toBeTruthy());
	});

	it("keeps a failed pairing setup's message and the selected address through a refresh", async () => {
		serverState = { status: "disabled", generation: 0, grants: [], lanAddresses: ["192.168.1.21", "192.168.1.22"] };
		configure.mockRejectedValueOnce(new Error("Local network address is unavailable"));
		const user = userEvent.setup();
		render(<WebAccessSettings />);
		await waitFor(() => expect(getState).toHaveBeenCalledOnce());
		await user.selectOptions(screen.getByLabelText("webAccess.networkLabel"), "192.168.1.22");
		await user.click(screen.getByRole("button", { name: "webAccess.pair" }));
		await waitFor(() => expect(screen.getByText("Local network address is unavailable")).toBeTruthy());
		expect(configure).toHaveBeenCalledWith({ origin: "http://192.168.1.22:45821", port: 45821 });
		await waitFor(() => expect(getState.mock.calls.length).toBeGreaterThan(1), POLL_WAIT);
		expect(screen.getByText("Local network address is unavailable")).toBeTruthy();
		expect((screen.getByLabelText("webAccess.networkLabel") as HTMLSelectElement).value).toBe("192.168.1.22");
		expect(pair).not.toHaveBeenCalled();
	});
});
