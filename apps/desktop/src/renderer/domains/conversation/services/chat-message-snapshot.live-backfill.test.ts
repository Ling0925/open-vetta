import { createAssistantMessage } from "@vetta/ai/protocol";
import type { HistoryEntry } from "@vetta/runtime-core";
import { beforeEach, describe, expect, it } from "vitest";
import { preserveMessagesAddedAfterSnapshot } from "./chat-message-snapshot";
import {
	appendTextDelta,
	finishAssistantTurn,
	fullHistoryToChat,
	handleToolEnd,
	resetStreamState,
	restoreAssistantTurn,
} from "./chat-service";

const currentTurn: HistoryEntry[] = [
	{ type: "message", entryId: "current-user", message: { role: "user", content: "Read this file", timestamp: 1000 } },
	{
		type: "message",
		entryId: "current-assistant",
		message: {
			...createAssistantMessage(
				{ api: "openai-responses", provider: "fixture", model: "fixture" },
				{ timestamp: 1001 },
			),
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "note.txt" } }],
			stopReason: "toolUse",
		},
	},
];
const precedingTurn: HistoryEntry[] = [
	{ type: "message", entryId: "earlier-user", message: { role: "user", content: "Earlier question", timestamp: 100 } },
];

describe("live updates during full-history backfill", () => {
	beforeEach(() => resetStreamState());

	it("keeps streamed text and tool results when a restored preview row already has its durable identity", () => {
		const preview = fullHistoryToChat(currentTurn);
		const canonical = fullHistoryToChat([...precedingTurn, ...currentTurn]);
		const restored = restoreAssistantTurn(preview, 1000);
		const withTool = handleToolEnd(restored, "read-1", "file contents", false);
		const live = appendTextDelta(withTool, "The file contains the requested information.");

		const merged = preserveMessagesAddedAfterSnapshot(preview, canonical, live);

		expect(merged.map((message) => message.id)).toEqual(["earlier-user", "current-user", "current-assistant"]);
		expect(merged.at(-1)).toMatchObject({
			id: "current-assistant",
			phase: "streaming",
			text: "The file contains the requested information.",
			blocks: [
				expect.objectContaining({ toolCallId: "read-1", status: "success", result: "file contents" }),
				expect.objectContaining({ type: "text", text: "The file contains the requested information." }),
			],
		});
		expect(appendTextDelta(merged, " More follows.").at(-1)).toMatchObject({
			id: "current-assistant",
			text: "The file contains the requested information. More follows.",
		});
	});

	it("does not undo a turn completion that arrived while the older history snapshot was loading", () => {
		const preview = fullHistoryToChat(currentTurn);
		const canonical = fullHistoryToChat([...precedingTurn, ...currentTurn]);
		const live = finishAssistantTurn(appendTextDelta(restoreAssistantTurn(preview, 1000), "Finished."), 2000);

		const merged = preserveMessagesAddedAfterSnapshot(preview, canonical, live);

		expect(merged.at(-1)).toMatchObject({
			id: "current-assistant",
			phase: "completed",
			endedAt: 2000,
			text: "Finished.",
		});
	});

	it("keeps the canonical array when the preview received no live updates", () => {
		const preview = fullHistoryToChat(currentTurn);
		const canonical = fullHistoryToChat([...precedingTurn, ...currentTurn]);

		expect(preserveMessagesAddedAfterSnapshot(preview, canonical, preview)).toBe(canonical);
	});

	it("does not let a restored pending tool replace its already persisted result", () => {
		const preview = fullHistoryToChat(currentTurn);
		const restored = restoreAssistantTurn(preview, 1000);
		const canonical = fullHistoryToChat([
			...precedingTurn,
			...currentTurn,
			{
				type: "message",
				entryId: "read-result",
				message: {
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: "saved result" }],
					isError: false,
					timestamp: 1100,
				},
			},
		]);

		expect(preserveMessagesAddedAfterSnapshot(preview, canonical, restored).at(-1)).toMatchObject({
			phase: "streaming",
			blocks: [expect.objectContaining({ toolCallId: "read-1", status: "success", result: "saved result" })],
		});
	});

	it("accepts the durable terminal snapshot instead of reviving its restored streaming draft", () => {
		const preview = fullHistoryToChat(currentTurn);
		const restored = restoreAssistantTurn(preview, 1000);
		const canonical = fullHistoryToChat([
			...precedingTurn,
			...currentTurn,
			{
				type: "assistant_turn_timing",
				timing: { startedAt: 1000, endedAt: 2000, durationMs: 1000 },
				timestamp: new Date(2000).toISOString(),
			},
		]);

		expect(preserveMessagesAddedAfterSnapshot(preview, canonical, restored)).toBe(canonical);
		expect(canonical.at(-1)).toMatchObject({ phase: "completed", endedAt: 2000 });
	});

	it.each(["Checking completed", "Checking"])(
		"keeps post-tool text %j after the tool instead of merging it into the earlier paragraph",
		(reply) => {
			const entries: HistoryEntry[] = currentTurn.map((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? {
							...entry,
							message: {
								...entry.message,
								content: [{ type: "text", text: "Checking" }, ...entry.message.content],
							},
						}
					: entry,
			);
			const preview = fullHistoryToChat(entries);
			const canonical = fullHistoryToChat([...precedingTurn, ...entries]);
			const live = appendTextDelta(
				handleToolEnd(restoreAssistantTurn(preview, 1000), "read-1", "done", false),
				reply,
			);

			const merged = preserveMessagesAddedAfterSnapshot(preview, canonical, live);

			expect(merged.at(-1)).toMatchObject({
				blocks: [
					expect.objectContaining({ type: "text", text: "Checking" }),
					expect.objectContaining({ type: "tool_call", toolCallId: "read-1", result: "done" }),
					expect.objectContaining({ type: "text", text: reply }),
				],
			});
		},
	);

	it("does not duplicate a restored paragraph when canonical history has already added the following tool", () => {
		const preview = fullHistoryToChat(
			currentTurn.map((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? { ...entry, message: { ...entry.message, content: [{ type: "text", text: "Checking" }] } }
					: entry,
			),
		);
		const canonical = fullHistoryToChat(
			currentTurn.map((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? {
							...entry,
							message: {
								...entry.message,
								content: [{ type: "text", text: "Checking completed" }, ...entry.message.content],
							},
						}
					: entry,
			),
		);
		const live = appendTextDelta(restoreAssistantTurn(preview, 1000), " completed");

		expect(preserveMessagesAddedAfterSnapshot(preview, canonical, live).at(-1)).toMatchObject({
			blocks: [
				expect.objectContaining({ type: "text", text: "Checking completed" }),
				expect.objectContaining({ type: "tool_call", toolCallId: "read-1" }),
			],
		});
	});
});
