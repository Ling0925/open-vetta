// @vitest-environment jsdom

import { chatMessagesAtom } from "@shared/store/atoms";
import type { SessionEvent } from "@vetta/runtime-core";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setChatStreamOwner } from "../services/chat-service";
import { useSessionEventController } from "./useSessionEventController";

describe("useSessionEventController tool updates", () => {
	afterEach(() => setChatStreamOwner(null));

	it("shows command output snapshots before the tool finishes", () => {
		const sessionId = "session-1";
		const toolCallId = "command-1";
		const store = createStore();
		setChatStreamOwner(sessionId);
		const activeSessionRef = {
			current: { runtimeId: sessionId, cwd: "C:/workspace", sessionPath: "C:/sessions/session-1.jsonl" },
		};
		const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
		const { result } = renderHook(() => useSessionEventController({ activeSessionRef }), { wrapper });
		const handleEvent = result.current.createSessionEventHandler(sessionId);

		act(() => {
			handleEvent({
				schemaVersion: 1,
				channel: "runtime",
				type: "session.lifecycle",
				phase: "agent_start",
				sessionId,
				eventId: "event-start",
				timestamp: 1,
				source: "runtime-core",
			} satisfies SessionEvent);
			handleEvent({
				schemaVersion: 1,
				channel: "runtime",
				type: "tool.start",
				sessionId,
				eventId: "event-tool-start",
				timestamp: 2,
				source: "tool",
				toolCallId,
				toolName: "bash",
				args: { command: "long-running-command" },
				startedAt: 2,
			} satisfies SessionEvent);
			handleEvent({
				schemaVersion: 1,
				channel: "runtime",
				type: "tool.update",
				sessionId,
				eventId: "event-tool-update-1",
				timestamp: 3,
				source: "tool",
				toolCallId,
				toolName: "bash",
				partialResult: { content: [{ type: "text", text: "first output" }] },
			} satisfies SessionEvent);
		});

		const pendingTool = store
			.get(chatMessagesAtom)
			.flatMap((message) => (message.kind === "agent" ? message.blocks : []))
			.find((block) => block.type === "tool_call" && block.toolCallId === toolCallId);
		expect(pendingTool).toMatchObject({ status: "pending", partialResult: "first output" });

		act(() => {
			handleEvent({
				schemaVersion: 1,
				channel: "runtime",
				type: "tool.update",
				sessionId,
				eventId: "event-tool-update-2",
				timestamp: 4,
				source: "tool",
				toolCallId,
				toolName: "bash",
				partialResult: { content: [{ type: "text", text: "first output\nlatest output" }] },
			} satisfies SessionEvent);
		});
		const updatedTool = store
			.get(chatMessagesAtom)
			.flatMap((message) => (message.kind === "agent" ? message.blocks : []))
			.find((block) => block.type === "tool_call" && block.toolCallId === toolCallId);
		expect(updatedTool).toMatchObject({ status: "pending", partialResult: "first output\nlatest output" });

		act(() => {
			handleEvent({
				schemaVersion: 1,
				channel: "runtime",
				type: "tool.end",
				sessionId,
				eventId: "event-tool-end",
				timestamp: 5,
				source: "tool",
				toolCallId,
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "final output" }] },
				startedAt: 2,
				durationMs: 3,
				phases: [],
			} satisfies SessionEvent);
		});
		const completedTool = store
			.get(chatMessagesAtom)
			.flatMap((message) => (message.kind === "agent" ? message.blocks : []))
			.find((block) => block.type === "tool_call" && block.toolCallId === toolCallId);
		expect(completedTool).toMatchObject({ status: "success", result: "final output" });
		if (completedTool?.type === "tool_call") expect("partialResult" in completedTool).toBe(false);
	});
});
