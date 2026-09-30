// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageFeedScrollModel } from "./useMessageFeedScrollModel";

const items = [{ id: "first" }, { id: "target" }, { id: "last" }];
const getItemKey = (item: { id: string }) => item.id;

describe("message feed navigation ownership", () => {
	let frames: Map<number, FrameRequestCallback>;

	beforeEach(() => {
		frames = new Map();
		let frameId = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function flushFrame() {
		act(() => {
			const pending = [...frames.entries()];
			for (const [id, callback] of pending) {
				if (!frames.delete(id)) continue;
				callback(0);
			}
		});
	}

	it("does not apply a previous conversation's queued message position to the next conversation", () => {
		const onInitialTargetHandled = vi.fn();
		const { result, rerender } = renderHook(
			({ resetKey, target }: { resetKey: string; target: string | null }) =>
				useMessageFeedScrollModel({
					active: false,
					items,
					resetKey,
					initialTargetKey: target,
					getItemKey,
					onInitialTargetHandled,
				}),
			{ initialProps: { resetKey: "search-a", target: "target" as string | null } },
		);
		const nextScrollToIndex = vi.fn();
		rerender({ resetKey: "search-b", target: null });
		result.current.virtuosoRef.current = { scrollToIndex: nextScrollToIndex } as unknown as VirtuosoHandle;

		flushFrame();

		expect(nextScrollToIndex).not.toHaveBeenCalled();
		expect(onInitialTargetHandled).not.toHaveBeenCalled();
	});

	it("only scrolls to the latest message destination when it changes before the next frame", () => {
		const { result, rerender } = renderHook(
			({ target }) =>
				useMessageFeedScrollModel({
					active: false,
					items,
					resetKey: "search-latest",
					initialTargetKey: target,
					getItemKey,
				}),
			{ initialProps: { target: "first" } },
		);
		const scrollToIndex = vi.fn();
		result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
		rerender({ target: "target" });

		flushFrame();

		expect(scrollToIndex.mock.calls).toEqual([[{ index: 1, align: "center", behavior: "smooth" }]]);
	});

	it("acknowledges a message target after navigation so clearing it does not cancel the user's jump", () => {
		const { result } = renderHook(() => {
			const [target, setTarget] = useState<string | null>("target");
			const scroll = useMessageFeedScrollModel({
				active: false,
				items,
				resetKey: "search-acknowledged",
				initialTargetKey: target,
				getItemKey,
				onInitialTargetHandled: () => setTarget(null),
			});
			return { scroll, target };
		});
		const scrollToIndex = vi.fn();
		result.current.scroll.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;

		expect(result.current.target).toBe("target");
		flushFrame();

		expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, align: "center", behavior: "smooth" });
		expect(result.current.target).toBeNull();
	});

	it("keeps the target pending when the virtualizer is unavailable at the queued navigation frame", () => {
		const onInitialTargetHandled = vi.fn();
		const { result, rerender } = renderHook(
			({ visibleItems }) =>
				useMessageFeedScrollModel({
					active: false,
					items: visibleItems,
					resetKey: "navigation-not-ready",
					initialTargetKey: "target",
					getItemKey,
					onInitialTargetHandled,
				}),
			{ initialProps: { visibleItems: items } },
		);

		expect(result.current.virtuosoRef.current).toBeNull();
		flushFrame();
		expect(onInitialTargetHandled).not.toHaveBeenCalled();

		const scrollToIndex = vi.fn();
		result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
		rerender({ visibleItems: [...items] });
		flushFrame();

		expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, align: "center", behavior: "smooth" });
		expect(onInitialTargetHandled).toHaveBeenCalledOnce();
	});

	it("keeps a message jump in an already-open conversation from being pulled back to the streaming tail", () => {
		const { result, rerender } = renderHook(
			({ target }: { target: string | null }) =>
				useMessageFeedScrollModel({
					active: true,
					items,
					resetKey: "search-browsing",
					initialTargetKey: target,
					getItemKey,
				}),
			{ initialProps: { target: null as string | null } },
		);
		const element = document.createElement("div");
		Object.defineProperties(element, {
			scrollHeight: { configurable: true, value: 1600 },
			clientHeight: { configurable: true, value: 400 },
			scrollTop: { configurable: true, writable: true, value: 1200 },
		});
		act(() => result.current.scrollerRef(element));
		flushFrame();
		const scrollToIndex = vi.fn(() => {
			element.scrollTop = 400;
		});
		result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;

		rerender({ target: "target" });
		// Virtuoso can still report the old bottom position while the jump is queued.
		act(() => result.current.onAtBottomChange(true));
		flushFrame();
		act(() => result.current.onTotalListHeightChange(1600));
		flushFrame();

		expect(result.current.followOutput).toBe(false);
		expect(element.scrollTop).toBe(400);

		act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 })));
		act(() => result.current.onAtBottomChange(true));
		flushFrame();
		expect(result.current.followOutput).toBe("auto");
	});

	it("drops a queued message jump when its feed unmounts", () => {
		const onInitialTargetHandled = vi.fn();
		const { result, unmount } = renderHook(() =>
			useMessageFeedScrollModel({
				active: false,
				items,
				resetKey: "search-unmount",
				initialTargetKey: "target",
				getItemKey,
				onInitialTargetHandled,
			}),
		);
		const scrollToIndex = vi.fn();
		result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
		unmount();

		flushFrame();

		expect(scrollToIndex).not.toHaveBeenCalled();
		expect(onInitialTargetHandled).not.toHaveBeenCalled();
	});
});
