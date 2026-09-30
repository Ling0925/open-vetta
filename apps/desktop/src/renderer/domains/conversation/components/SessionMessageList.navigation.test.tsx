// @vitest-environment jsdom

import { createConversationUserMessage } from "@shared/conversation";
import { i18n, initI18n } from "@shared/i18n";
import type { ChatConversationItem } from "@shared/store/atoms";
import {
	activeSessionAtom,
	chatMessagesAtom,
	openSessionFnRef,
	pendingScrollToEntryAtom,
	pendingSessionOpenAtom,
} from "@shared/store/atoms";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { getDefaultStore, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import type { IndexLocationWithAlign } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMessageList } from "./SessionMessageList";

const observed = vi.hoisted(() => ({
	jumps: [] as Array<{ ids: string[]; location: IndexLocationWithAlign }>,
}));

// Only replace the browser layout boundary; the session recipe, banner, atoms,
// message rendering and viewport controller remain wired together.
vi.mock("react-virtuoso", async () => {
	const { Fragment, forwardRef, useImperativeHandle } = await import("react");
	return {
		Virtuoso: forwardRef(function TestVirtualizer(
			{
				data,
				itemContent,
				computeItemKey,
			}: {
				data: ChatConversationItem[];
				itemContent: (index: number, item: ChatConversationItem) => ReactNode;
				computeItemKey: (index: number, item: ChatConversationItem) => string;
			},
			ref,
		) {
			useImperativeHandle(ref, () => ({
				scrollToIndex: (location: IndexLocationWithAlign) => {
					observed.jumps.push({ ids: data.map((item) => item.id), location });
				},
			}));
			return (
				<>
					{data.map((item, index) => (
						<Fragment key={computeItemKey(index, item)}>{itemContent(index, item)}</Fragment>
					))}
				</>
			);
		}),
	};
});

const store = getDefaultStore();
const workspace = { id: "navigation-workspace", cwd: "/repo", runtimeIds: [] };
const sourceMessage = createConversationUserMessage({
	id: "shared-source",
	entryId: "source-entry",
	text: "Source question",
});
const recentMessage = createConversationUserMessage({ id: "recent-message", text: "Recent question" });

function Conversation() {
	const session = useAtomValue(activeSessionAtom);
	const pending = useAtomValue(pendingSessionOpenAtom);
	const messages = useAtomValue(chatMessagesAtom);
	return (
		<SessionMessageList
			messages={messages}
			isStreaming={false}
			workspace={workspace}
			sessionId={pending?.sessionPath ?? session?.sessionPath}
		/>
	);
}

function deferredOpen() {
	let resolve: () => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

describe("fork-origin message navigation", () => {
	let frames: Map<number, FrameRequestCallback>;

	beforeEach(() => {
		initI18n();
		void i18n.changeLanguage("zh");
		observed.jumps = [];
		frames = new Map();
		let nextFrame = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		Object.defineProperty(window, "vetta", {
			configurable: true,
			value: {
				models: { get: async () => ({ providers: {} }), fetchRemote: async () => ({ providers: {} }) },
				skills: { list: async () => [] },
				abilities: { listOpenMarketplaces: async () => ({ abilities: [] }) },
			},
		});
		store.set(pendingScrollToEntryAtom, null);
		store.set(pendingSessionOpenAtom, null);
		store.set(activeSessionAtom, {
			cwd: "/repo",
			sessionPath: "/fork.jsonl",
			runtimeId: "fork-runtime",
			parentSessionPath: "/parent.jsonl",
			parentEntryId: "source-entry",
		});
		store.set(chatMessagesAtom, [sourceMessage]);
	});

	afterEach(() => {
		openSessionFnRef.current = null;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function flushFrame() {
		act(() => {
			for (const [id, callback] of [...frames]) {
				if (frames.delete(id)) callback(0);
			}
		});
	}

	it("preserves the source jump through the tail preview until full history contains the requested message", async () => {
		const opened = deferredOpen();
		openSessionFnRef.current = vi.fn((_cwd, sessionPath) => {
			store.set(pendingSessionOpenAtom, {
				cwd: "/repo",
				sessionPath: sessionPath ?? "",
				interactionId: "open-parent",
			});
			store.set(activeSessionAtom, null);
			store.set(chatMessagesAtom, []);
			return opened.promise;
		});
		render(<Conversation />);
		fireEvent.click(screen.getByRole("button", { name: /分叉自消息/ }));

		// openViewer presents recent turns before Runtime readiness and full history.
		act(() => store.set(chatMessagesAtom, [recentMessage]));
		flushFrame();
		expect(observed.jumps).toEqual([]);
		expect(store.get(pendingScrollToEntryAtom)).toMatchObject({ entryId: "source-entry" });

		await act(async () => {
			store.set(activeSessionAtom, { cwd: "/repo", sessionPath: "/parent.jsonl", runtimeId: "parent-runtime" });
			store.set(pendingSessionOpenAtom, null);
			opened.resolve();
			await opened.promise;
		});
		flushFrame();
		expect(observed.jumps).toEqual([]);

		act(() => store.set(chatMessagesAtom, [sourceMessage, recentMessage]));
		flushFrame();
		expect(observed.jumps).toEqual([
			{ ids: ["shared-source", "recent-message"], location: { index: 0, align: "center", behavior: "smooth" } },
		]);
		expect(store.get(pendingScrollToEntryAtom)).toBeNull();
	});

	it("does not let a different conversation with the same entry id consume the requested destination", () => {
		openSessionFnRef.current = vi.fn(() => new Promise<void>(() => undefined));
		render(<Conversation />);
		fireEvent.click(screen.getByRole("button", { name: /分叉自消息/ }));
		act(() =>
			store.set(activeSessionAtom, { cwd: "/repo", sessionPath: "/other.jsonl", runtimeId: "other-runtime" }),
		);
		flushFrame();

		expect(observed.jumps).toEqual([]);
		expect(store.get(pendingScrollToEntryAtom)).toMatchObject({
			sessionPath: "/parent.jsonl",
			entryId: "source-entry",
		});
	});

	it("keeps the newer destination when an older parent-open request fails late", async () => {
		const first = deferredOpen();
		const second = deferredOpen();
		openSessionFnRef.current = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		render(<Conversation />);
		fireEvent.click(screen.getByRole("button", { name: /分叉自消息/ }));
		act(() =>
			store.set(activeSessionAtom, {
				cwd: "/repo",
				sessionPath: "/second-fork.jsonl",
				runtimeId: "second-fork-runtime",
				parentSessionPath: "/second-parent.jsonl",
				parentEntryId: "source-entry",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: /分叉自消息/ }));
		await act(async () => {
			first.reject(new Error("Parent unavailable"));
			await first.promise.catch(() => undefined);
		});

		expect(store.get(pendingScrollToEntryAtom)).toMatchObject({
			sessionPath: "/second-parent.jsonl",
			entryId: "source-entry",
		});
		await act(async () => {
			second.resolve();
			await second.promise;
		});
	});

	it("clears only its own destination when opening resolves after a handled navigation failure", async () => {
		const opened = deferredOpen();
		openSessionFnRef.current = vi.fn(() => opened.promise);
		render(<Conversation />);
		fireEvent.click(screen.getByRole("button", { name: /分叉自消息/ }));
		await act(async () => {
			store.set(activeSessionAtom, null);
			store.set(chatMessagesAtom, []);
			opened.resolve();
			await opened.promise;
		});

		expect(store.get(pendingScrollToEntryAtom)).toBeNull();
		expect(observed.jumps).toEqual([]);
	});
});
