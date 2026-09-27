// @vitest-environment jsdom
import {
	activeSessionAtom,
	cancelSessionOpenFnRef,
	defaultConversationCwdAtom,
	pendingSessionOpenAtom,
} from "@shared/store/atoms";
import { act, renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
let matches: Array<{ pathname: string; params: Record<string, string> }> = [{ pathname: "/", params: {} }];

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useMatches: () => matches,
}));

const { useNewChatNavigation } = await import("./useNewChatNavigation.js");

describe("useNewChatNavigation", () => {
	beforeEach(() => {
		navigate.mockReset();
		matches = [{ pathname: "/", params: {} }];
		const store = getDefaultStore();
		store.set(activeSessionAtom, null);
		store.set(pendingSessionOpenAtom, null);
		store.set(defaultConversationCwdAtom, "/default");
		cancelSessionOpenFnRef.current = vi.fn();
	});

	it("uses the pending conversation target cwd while Runtime identity is still unavailable", async () => {
		const store = getDefaultStore();
		store.set(pendingSessionOpenAtom, {
			cwd: "/repo/target",
			sessionPath: "/sessions/target.jsonl",
			interactionId: "open-target",
		});
		const { result } = renderHook(() => useNewChatNavigation());

		await act(async () => {
			result.current();
			await Promise.resolve();
		});

		expect(cancelSessionOpenFnRef.current).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith({
			to: "/new-session/$cwd",
			params: { cwd: encodeURIComponent("/repo/target") },
		});
	});

	it("keeps the active Runtime cwd fallback when no pending target exists", async () => {
		getDefaultStore().set(activeSessionAtom, {
			cwd: "/repo/active",
			sessionPath: "/sessions/active.jsonl",
			runtimeId: "runtime-active",
		});
		const { result } = renderHook(() => useNewChatNavigation());

		await act(async () => {
			result.current();
			await Promise.resolve();
		});

		expect(navigate).toHaveBeenCalledWith({
			to: "/new-session/$cwd",
			params: { cwd: encodeURIComponent("/repo/active") },
		});
	});
});
