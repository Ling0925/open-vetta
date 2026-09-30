// @vitest-environment jsdom

import { createConversationUserMessage } from "@shared/conversation";
import { activeSessionStreamingAtom, chatMessagesAtom } from "@shared/store/atoms";
import { bumpQueuedDispatchSeq, messageQueueBySessionAtom } from "@shared/store/message-queue-atoms";
import { act, renderHook } from "@testing-library/react";
import { createAssistantMessage, type ToolResultMessage } from "@vetta/ai";
import type { HistoryEntry, SessionEvent } from "@vetta/runtime-core";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStreamState, setChatStreamOwner } from "../services/chat-service";
import { useSessionEventController } from "./useSessionEventController";

const sessionId = "event-ordering-session";
const store = getDefaultStore();
const getFullHistory = vi.fn<() => Promise<HistoryEntry[]>>();

function deferredHistory() {
	let resolve: (value: HistoryEntry[]) => void = () => {};
	const promise = new Promise<HistoryEntry[]>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function history(question = "first question", answer = "first answer"): HistoryEntry[] {
	return [
		{ type: "message", entryId: "persisted-user", message: { role: "user", content: question, timestamp: 1 } },
		{
			type: "message",
			entryId: "persisted-agent",
			message: {
				...createAssistantMessage({ api: "test", provider: "test", model: "fixture" }, { timestamp: 3 }),
				content: [{ type: "text", text: answer }],
			},
		},
	];
}

function lifecycle(phase: "agent_start" | "agent_end", timestamp: number): SessionEvent {
	return {
		schemaVersion: 1,
		channel: "runtime",
		type: "session.lifecycle",
		phase,
		sessionId,
		eventId: `event-${phase}-${timestamp}`,
		timestamp,
		source: "runtime-core",
	};
}

function delta(type: "message.delta" | "thinking.delta", text: string): SessionEvent {
	return {
		schemaVersion: 1,
		channel: "runtime",
		type,
		delta: text,
		sessionId,
		eventId: `event-${type}-${text}`,
		timestamp: 2,
		source: "agent",
	};
}

function compactionEnd(): SessionEvent {
	return {
		schemaVersion: 1,
		channel: "runtime",
		type: "compaction.end",
		sessionId,
		eventId: "compaction-end",
		timestamp: 4,
		source: "runtime-core",
		success: true,
		reason: "manual",
	};
}

function mountController() {
	const activeSessionRef = {
		current: { runtimeId: sessionId, cwd: "/workspace", sessionPath: "/sessions/event-ordering.jsonl" },
	};
	const hook = renderHook(() => useSessionEventController({ activeSessionRef }));
	return { ...hook, activeSessionRef, handle: hook.result.current.createSessionEventHandler(sessionId) };
}

function firstTurn(handle: (event: SessionEvent) => void) {
	act(() => {
		store.set(chatMessagesAtom, [createConversationUserMessage({ id: "live-user", text: "first question" })]);
		handle(lifecycle("agent_start", 1));
		handle(delta("message.delta", "first answer"));
		handle(lifecycle("agent_end", 3));
	});
}

function nextTurn(handle: (event: SessionEvent) => void) {
	act(() => {
		store.set(chatMessagesAtom, (previous) => [
			...previous,
			createConversationUserMessage({ id: "next-user", text: "next question" }),
		]);
		handle(lifecycle("agent_start", 5));
		handle(delta("message.delta", "next answer"));
		vi.advanceTimersByTime(100);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	getFullHistory.mockReset();
	resetStreamState();
	setChatStreamOwner(sessionId);
	store.set(chatMessagesAtom, []);
	store.set(activeSessionStreamingAtom, false);
	store.set(messageQueueBySessionAtom, new Map());
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: { session: { getFullHistory }, config: { get: vi.fn(async () => ({})) } },
	});
});

afterEach(() => {
	setChatStreamOwner(null);
	resetStreamState();
	vi.useRealTimers();
});

describe("session event ordering", () => {
	it("streams a reply, flushes its final delta, and attaches durable history identities", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		firstTurn(handle);
		expect(store.get(activeSessionStreamingAtom)).toBe(false);
		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({ text: "first answer", phase: "completed" });

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toMatchObject([
			{ id: "live-user", entryId: "persisted-user", text: "first question" },
			{ entryId: "persisted-agent", text: "first answer", phase: "completed" },
		]);
	});

	it.each(["", "complete"])(
		"restores authoritative final-only content after receiving %j streamed text",
		async (streamed) => {
			const pending = deferredHistory();
			getFullHistory.mockReturnValue(pending.promise);
			const { handle } = mountController();
			const canonical = history("first question", "complete answer");
			const final = canonical[1];
			if (final.type !== "message") throw new Error("Expected assistant history fixture");
			act(() => {
				store.set(chatMessagesAtom, [createConversationUserMessage({ id: "live-user", text: "first question" })]);
				handle(lifecycle("agent_start", 1));
				if (streamed) handle(delta("message.delta", streamed));
				// Codex item/completed and terminal history reconciliation can deliver a
				// full message without the corresponding text delta notifications.
				handle({
					schemaVersion: 1,
					channel: "runtime",
					type: "message.final",
					sessionId,
					eventId: "final-only",
					timestamp: 3,
					source: "runtime-core",
					message: final.message,
				});
				handle(lifecycle("agent_end", 4));
			});

			await act(async () => pending.resolve(canonical));

			expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({
				text: "complete answer",
				blocks: [{ type: "text", text: "complete answer" }],
			});
		},
	);

	it("restores a completed tool result delivered only by final history reconciliation", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		const assistant = {
			...createAssistantMessage({ api: "test", provider: "test", model: "fixture" }, { timestamp: 2 }),
			content: [{ type: "toolCall" as const, id: "tool-final", name: "read", arguments: { path: "README.md" } }],
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-final",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 3,
		};
		const canonical: HistoryEntry[] = [
			{
				type: "message",
				entryId: "persisted-user",
				message: { role: "user", content: "first question", timestamp: 1 },
			},
			{ type: "message", entryId: "persisted-agent", message: assistant },
			{ type: "message", entryId: "persisted-result", message: toolResult },
		];
		act(() => {
			store.set(chatMessagesAtom, [createConversationUserMessage({ id: "live-user", text: "first question" })]);
			handle(lifecycle("agent_start", 1));
			for (const message of [assistant, toolResult])
				handle({
					schemaVersion: 1,
					channel: "runtime",
					type: "message.final",
					sessionId,
					eventId: `final-${message.role}`,
					timestamp: 3,
					source: "runtime-core",
					message,
				});
			handle(lifecycle("agent_end", 4));
		});

		await act(async () => pending.resolve(canonical));

		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({
			blocks: [{ type: "tool_call", toolCallId: "tool-final", status: "success", result: "file contents" }],
		});
	});

	it.each([false, true])(
		"keeps the next reply when an earlier turn history arrives late (queued=%s)",
		async (queued) => {
			const pending = deferredHistory();
			getFullHistory.mockReturnValue(pending.promise);
			const { handle } = mountController();
			firstTurn(handle);
			if (queued) bumpQueuedDispatchSeq(sessionId);
			nextTurn(handle);
			const current = store.get(chatMessagesAtom);

			await act(async () => pending.resolve(history()));

			expect(store.get(chatMessagesAtom)).toBe(current);
			expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({ text: "next answer", phase: "streaming" });
			expect(store.get(activeSessionStreamingAtom)).toBe(true);
		},
	);

	it("protects a newly submitted question before its agent_start event arrives", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle, result } = mountController();
		firstTurn(handle);
		act(() => {
			result.current.bumpSuggestionToken(sessionId);
			store.set(chatMessagesAtom, (previous) => [
				...previous,
				createConversationUserMessage({ id: "submitted", text: "next question" }),
			]);
		});
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it.each(["compaction", "queue"])("invalidates completed-turn history when %s work begins", async (boundary) => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		firstTurn(handle);
		act(() => {
			if (boundary === "compaction") {
				handle({
					schemaVersion: 1,
					channel: "runtime",
					type: "compaction.start",
					reason: "manual",
					sessionId,
					eventId: "compaction-start",
					timestamp: 4,
					source: "runtime-core",
				});
			} else {
				store.set(
					messageQueueBySessionAtom,
					new Map([
						[
							sessionId,
							[
								{
									id: "compact-next",
									displayText: "context.compact",
									behavior: "followUp",
									kind: "context_compaction",
								},
							],
						],
					]),
				);
				handle({
					schemaVersion: 1,
					channel: "runtime",
					type: "queue.changed",
					sessionId,
					eventId: "queue-consumed",
					timestamp: 4,
					source: "runtime-core",
					entries: [],
					paused: false,
					snapshot: {},
				});
			}
		});
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it("does not let completed compaction overwrite a newly started reply", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		act(() => handle(compactionEnd()));
		nextTurn(handle);
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it("discards history from the previous visit after reopening the same session", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle, result } = mountController();
		firstTurn(handle);
		act(() => {
			result.current.resetEventBuffers();
			store.set(chatMessagesAtom, [createConversationUserMessage({ id: "reopened", text: "restored branch" })]);
		});
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it("discards history after the controller is unmounted", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle, unmount } = mountController();
		firstTurn(handle);
		unmount();
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it("does not write an old history response after stream ownership is relinquished", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		firstTurn(handle);
		setChatStreamOwner(null);
		const current = store.get(chatMessagesAtom);

		await act(async () => pending.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
	});

	it("keeps only the latest requested history when compaction responses arrive out of order", async () => {
		const older = deferredHistory();
		const newer = deferredHistory();
		getFullHistory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		const { handle } = mountController();
		act(() => {
			handle(compactionEnd());
			handle(compactionEnd());
		});
		await act(async () => newer.resolve(history("latest question", "latest answer")));
		const current = store.get(chatMessagesAtom);

		await act(async () => older.resolve(history()));

		expect(store.get(chatMessagesAtom)).toBe(current);
		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({ text: "latest answer" });
	});

	it("preserves text and thinking wire order inside a throttled legacy batch", () => {
		const { handle } = mountController();
		act(() => {
			handle(lifecycle("agent_start", 1));
			handle(delta("message.delta", "before"));
			handle(delta("thinking.delta", "reason"));
			handle(delta("message.delta", "after"));
		});
		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({ blocks: [] });

		act(() => vi.advanceTimersByTime(100));

		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({
			text: "beforeafter",
			blocks: [
				{ type: "text", text: "before" },
				{ type: "thinking", text: "reason" },
				{ type: "text", text: "after" },
			],
		});
	});
	it("flushes the text before a tool and the trailing text before turn completion", async () => {
		const pending = deferredHistory();
		getFullHistory.mockReturnValue(pending.promise);
		const { handle } = mountController();
		act(() => {
			handle(lifecycle("agent_start", 1));
			handle(delta("message.delta", "before tool"));
			handle({
				schemaVersion: 1,
				channel: "runtime",
				type: "tool.start",
				sessionId,
				eventId: "tool",
				timestamp: 2,
				source: "tool",
				toolCallId: "tool-1",
				toolName: "read",
				args: {},
				startedAt: 2,
			});
			handle(delta("message.delta", "after tool"));
			handle(lifecycle("agent_end", 4));
		});

		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({
			text: "before toolafter tool",
			blocks: [
				{ type: "text", text: "before tool" },
				{ type: "tool_call", toolCallId: "tool-1" },
				{ type: "text", text: "after tool" },
			],
		});
	});

	it("does not duplicate raw assistant deltas through the legacy compatibility channel", () => {
		const { handle } = mountController();
		act(() => {
			handle(lifecycle("agent_start", 1));
			handle({
				schemaVersion: 1,
				channel: "assistant",
				type: "text_delta",
				sessionId,
				eventId: "raw-text",
				timestamp: 2,
				source: "agent",
				modelCallIndex: 0,
				contentIndex: 0,
				delta: "answer",
				partial: createAssistantMessage({ api: "test", provider: "test", model: "fixture" }),
			});
			handle(delta("message.delta", "answer"));
			vi.advanceTimersByTime(100);
		});

		expect(store.get(chatMessagesAtom).at(-1)).toMatchObject({ text: "answer" });
	});
});
