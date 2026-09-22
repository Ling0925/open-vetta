import { type AssistantMessage, type AssistantMessageEvent, createAssistantMessage } from "@vetta/ai";
import type { AssistantSessionEvent, SessionEvent } from "@vetta/runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TOOL_CALL_DELTA_MAX_BATCH_DELAY_MS,
	ToolCallDeltaTransportMerger,
} from "./tool-call-delta-transport-merger.js";

function assistantMessage(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		...createAssistantMessage({ api: "openai-completions", provider: "openai", model: "gpt-test" }, { timestamp: 1 }),
		content,
	};
}

function toolPartial(toolCallId: string, content = "", contentIndex = 0): AssistantMessage {
	const blocks: AssistantMessage["content"] = Array.from({ length: contentIndex }, (_, index) => ({
		type: "text",
		text: `before-${index}`,
	}));
	blocks.push({
		type: "toolCall",
		id: toolCallId,
		name: "Write",
		arguments: { path: "/project/large.txt", content },
	});
	return assistantMessage(blocks);
}

function setToolContent(partial: AssistantMessage, contentIndex: number, content: string): void {
	const call = partial.content[contentIndex];
	if (call?.type !== "toolCall") throw new Error("expected tool call content");
	call.arguments.content = content;
}

function envelope(
	event: AssistantMessageEvent,
	sequence: number,
	overrides: Partial<Pick<AssistantSessionEvent, "sessionId" | "turnId" | "modelCallIndex">> = {},
): AssistantSessionEvent {
	return {
		schemaVersion: 1,
		sessionId: overrides.sessionId ?? "session-1",
		eventId: `event-${sequence}`,
		timestamp: sequence,
		source: "agent",
		sequence,
		channel: "assistant",
		turnId: overrides.turnId ?? "turn-1",
		modelCallIndex: overrides.modelCallIndex ?? 0,
		...event,
	};
}

function deltaEvent(
	partial: AssistantMessage,
	delta: string,
	sequence: number,
	contentIndex = 0,
): AssistantSessionEvent {
	return envelope({ type: "toolcall_delta", contentIndex, delta, partial }, sequence);
}

function lifecycleEvent(sequence: number, phase: "agent_start" | "aborted" = "agent_start"): SessionEvent {
	return {
		schemaVersion: 1,
		channel: "runtime",
		sessionId: "session-1",
		eventId: `runtime-${sequence}`,
		timestamp: sequence,
		source: "runtime-core",
		sequence,
		type: "session.lifecycle",
		phase,
	};
}

function snapshotSink(target: SessionEvent[]): (event: SessionEvent) => void {
	// Matches WebContents.send: values are structured-cloned synchronously.
	return (event) => target.push(structuredClone(event));
}

afterEach(() => vi.useRealTimers());

describe("ToolCallDeltaTransportMerger", () => {
	it("losslessly batches a large Write argument and exposes the latest display snapshot", () => {
		vi.useFakeTimers();
		const emitted: SessionEvent[] = [];
		const merger = new ToolCallDeltaTransportMerger({ emit: snapshotSink(emitted) });
		const partial = toolPartial("write-1");
		const chunks = Array.from({ length: 240 }, (_, index) => `${index.toString().padStart(3, "0")}:payload\n`);
		let completeContent = "";

		for (const [index, chunk] of chunks.entries()) {
			completeContent += chunk;
			setToolContent(partial, 0, completeContent);
			merger.push(deltaEvent(partial, chunk, index + 1));
		}

		vi.advanceTimersByTime(TOOL_CALL_DELTA_MAX_BATCH_DELAY_MS - 1);
		expect(emitted).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(emitted).toHaveLength(1);

		const batched = emitted[0];
		if (batched?.channel !== "assistant" || batched.type !== "toolcall_delta") {
			throw new Error("expected a batched tool-call delta");
		}
		expect(batched.delta).toBe(chunks.join(""));
		expect(batched).toMatchObject({ eventId: "event-240", timestamp: 240, sequence: 240 });
		const call = batched.partial.content[0];
		expect(call?.type === "toolCall" ? call.arguments.content : undefined).toBe(completeContent);
		expect(emitted.length).toBeLessThan(chunks.length);

		setToolContent(partial, 0, "mutated after transport");
		const sentCall = batched.partial.content[0];
		expect(sentCall?.type === "toolCall" ? sentCall.arguments.content : undefined).toBe(completeContent);
	});

	it("flushes before another tool, content index, start, terminal, error, or runtime event", () => {
		vi.useFakeTimers();
		const emitted: SessionEvent[] = [];
		const merger = new ToolCallDeltaTransportMerger({ emit: snapshotSink(emitted) });
		const first = toolPartial("write-1");
		const second = toolPartial("write-2", "", 1);
		const replacementAtSameIndex = toolPartial("write-3");

		merger.push(envelope({ type: "toolcall_start", contentIndex: 0, partial: first }, 1));
		merger.push(deltaEvent(first, "a", 2));
		merger.push(deltaEvent(first, "b", 3));
		merger.push(envelope({ type: "toolcall_start", contentIndex: 1, partial: second }, 4));
		merger.push(deltaEvent(second, "c", 5, 1));
		const secondCall = second.content[1];
		if (secondCall?.type !== "toolCall") throw new Error("expected second tool call");
		merger.push(envelope({ type: "toolcall_end", contentIndex: 1, toolCall: secondCall, partial: second }, 6));
		merger.push(deltaEvent(replacementAtSameIndex, "d", 7));
		merger.push(deltaEvent(first, "e", 8));
		merger.push(
			envelope({ type: "done", reason: "toolUse", message: { ...assistantMessage(), stopReason: "toolUse" } }, 9),
		);
		merger.push(deltaEvent(first, "f", 10));
		merger.push(
			envelope({ type: "error", reason: "error", error: { ...assistantMessage(), stopReason: "error" } }, 11),
		);
		merger.push(deltaEvent(first, "g", 12));
		merger.push(lifecycleEvent(13, "aborted"));

		expect(
			emitted.map((event) =>
				event.channel === "assistant" && event.type === "toolcall_delta"
					? `${event.type}:${event.delta}`
					: event.type,
			),
		).toEqual([
			"toolcall_start",
			"toolcall_delta:ab",
			"toolcall_start",
			"toolcall_delta:c",
			"toolcall_end",
			"toolcall_delta:d",
			"toolcall_delta:e",
			"done",
			"toolcall_delta:f",
			"error",
			"toolcall_delta:g",
			"session.lifecycle",
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps different content indexes in separate ordered batches", () => {
		vi.useFakeTimers();
		const emitted: SessionEvent[] = [];
		const merger = new ToolCallDeltaTransportMerger({ emit: snapshotSink(emitted) });

		merger.push(deltaEvent(toolPartial("write-1"), "first", 1));
		merger.push(deltaEvent(toolPartial("write-1", "", 1), "second", 2, 1));
		merger.push(lifecycleEvent(3));

		expect(
			emitted.map((event) =>
				event.channel === "assistant" && event.type === "toolcall_delta" ? event.delta : event.type,
			),
		).toEqual(["first", "second", "session.lifecycle"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards timers and queued data on stop without affecting another subscription", () => {
		vi.useFakeTimers();
		const firstOutput: SessionEvent[] = [];
		const secondOutput: SessionEvent[] = [];
		const first = new ToolCallDeltaTransportMerger({ emit: snapshotSink(firstOutput) });
		const second = new ToolCallDeltaTransportMerger({ emit: snapshotSink(secondOutput) });

		first.push(deltaEvent(toolPartial("first"), "discarded", 1));
		second.push(deltaEvent(toolPartial("second"), "kept", 1, 0));
		first.dispose();
		first.dispose();
		first.push(lifecycleEvent(2));
		vi.advanceTimersByTime(TOOL_CALL_DELTA_MAX_BATCH_DELAY_MS);

		expect(firstOutput).toEqual([]);
		expect(secondOutput).toHaveLength(1);
		const kept = secondOutput[0];
		expect(kept?.channel === "assistant" && kept.type === "toolcall_delta" ? kept.delta : undefined).toBe("kept");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes 50ms after the first token even when tokens keep arriving", () => {
		vi.useFakeTimers();
		const emitted: SessionEvent[] = [];
		const merger = new ToolCallDeltaTransportMerger({ emit: snapshotSink(emitted) });
		const partial = toolPartial("write-deadline");
		merger.push(deltaEvent(partial, "a", 1));
		vi.advanceTimersByTime(40);
		merger.push(deltaEvent(partial, "b", 2));
		vi.advanceTimersByTime(9);
		merger.push(deltaEvent(partial, "c", 3));
		expect(emitted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(emitted).toMatchObject([{ type: "toolcall_delta", delta: "abc" }]);
		merger.push(deltaEvent(partial, "d", 4));
		vi.advanceTimersByTime(49);
		expect(emitted).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(emitted).toMatchObject([{ delta: "abc" }, { delta: "d" }]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])(
		"does not enqueue or emit after a flush callback disposes the merger (terminal=%s)",
		(terminal) => {
			vi.useFakeTimers();
			const emitted: SessionEvent[] = [];
			const merger = new ToolCallDeltaTransportMerger({
				emit: (event) => {
					snapshotSink(emitted)(event);
					merger.dispose();
				},
			});
			merger.push(deltaEvent(toolPartial("write-a"), "a", 1));
			merger.push(terminal ? lifecycleEvent(2) : deltaEvent(toolPartial("write-b"), "b", 2));
			expect(emitted).toMatchObject([{ type: "toolcall_delta", delta: "a" }]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("preserves pending input before an event synchronously pushed by the flush callback", () => {
		vi.useFakeTimers();
		const emitted: SessionEvent[] = [];
		const merger = new ToolCallDeltaTransportMerger({
			emit: (event) => {
				snapshotSink(emitted)(event);
				if (emitted.length === 1) merger.push(deltaEvent(toolPartial("write-c"), "c", 3));
			},
		});
		merger.push(deltaEvent(toolPartial("write-a"), "a", 1));
		merger.push(deltaEvent(toolPartial("write-b"), "b", 2));
		merger.flush();
		expect(emitted).toMatchObject([{ delta: "a" }, { delta: "b" }, { delta: "c" }]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
