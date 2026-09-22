import { type AssistantMessage, type AssistantMessageEvent, createAssistantMessage } from "@vetta/ai";
import type { AssistantSessionEvent, SessionEvent } from "@vetta/runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSessionEvent } from "../../shared/session-event-codec.js";
import {
	createSessionEventIpcSubscription,
	type SessionEventSubscriptionSource,
} from "../conversations/session-event-ipc-subscription.js";

type RuntimeListener = (event: SessionEvent) => void;

class FakeRuntimeEventSource implements SessionEventSubscriptionSource {
	readonly #listeners = new Map<string, Set<RuntimeListener>>();

	subscribe(sessionId: string, listener: RuntimeListener): () => void {
		const listeners = this.#listeners.get(sessionId) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(sessionId, listeners);
		return () => listeners.delete(listener);
	}

	emit(sessionId: string, event: SessionEvent): void {
		for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
	}

	listenerCount(sessionId: string): number {
		return this.#listeners.get(sessionId)?.size ?? 0;
	}
}

function assistantMessage(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		...createAssistantMessage({ api: "openai-completions", provider: "openai", model: "gpt-test" }, { timestamp: 1 }),
		content,
	};
}

function assistantEvent(event: AssistantMessageEvent, sequence: number): AssistantSessionEvent {
	return {
		schemaVersion: 1,
		sessionId: "session-1",
		eventId: `event-${sequence}`,
		timestamp: sequence,
		source: "agent",
		sequence,
		channel: "assistant",
		turnId: "turn-1",
		modelCallIndex: 0,
		...event,
	};
}

function createDelivery(source: FakeRuntimeEventSource, emitted: SessionEvent[], isActive: () => boolean) {
	return createSessionEventIpcSubscription({
		source,
		sessionId: "session-1",
		isActive,
		// Matches Electron WebContents.send by taking a synchronous structured-clone snapshot.
		emit: (event) => emitted.push(structuredClone(event)),
	});
}

afterEach(() => vi.useRealTimers());

describe("session tool-call delta IPC subscription", () => {
	it("delivers a large tool generation through completion with fewer lossless IPC payloads", () => {
		vi.useFakeTimers();
		const source = new FakeRuntimeEventSource();
		const emitted: SessionEvent[] = [];
		const delivery = createDelivery(source, emitted, () => true);
		const partial = assistantMessage([
			{
				type: "toolCall",
				id: "write-1",
				name: "Write",
				arguments: { path: "/project/large.txt", content: "" },
			},
		]);
		source.emit("session-1", assistantEvent({ type: "toolcall_start", contentIndex: 0, partial }, 1));
		const chunks = Array.from({ length: 180 }, (_, index) => `line-${index}\n`);
		let completeContent = "";
		for (const [index, chunk] of chunks.entries()) {
			completeContent += chunk;
			const call = partial.content[0];
			if (call?.type !== "toolCall") throw new Error("expected Write call");
			call.arguments.content = completeContent;
			source.emit(
				"session-1",
				assistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: chunk, partial }, index + 2),
			);
		}
		const call = partial.content[0];
		if (call?.type !== "toolCall") throw new Error("expected final Write call");
		source.emit("session-1", assistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial }, 182));
		source.emit(
			"session-1",
			assistantEvent({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } }, 183),
		);

		const delivered = emitted.map(decodeSessionEvent);
		expect(delivered.map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const merged = delivered[1];
		if (merged?.channel !== "assistant" || merged.type !== "toolcall_delta") {
			throw new Error("expected merged tool-call delta");
		}
		expect(merged.delta).toBe(chunks.join(""));
		expect(merged.sequence).toBe(181);
		const displayedCall = merged.partial.content[0];
		expect(displayedCall?.type === "toolCall" ? displayedCall.arguments.content : undefined).toBe(completeContent);
		expect(delivered.length).toBeLessThan(chunks.length);
		expect(vi.getTimerCount()).toBe(0);
		delivery.dispose();
	});

	it("drops queued payloads and releases only the stopped or destroyed renderer subscription", () => {
		vi.useFakeTimers();
		const source = new FakeRuntimeEventSource();
		const firstOutput: SessionEvent[] = [];
		const secondOutput: SessionEvent[] = [];
		let secondActive = true;
		const first = createDelivery(source, firstOutput, () => true);
		createDelivery(source, secondOutput, () => secondActive);
		const partial = assistantMessage([
			{ type: "toolCall", id: "write-1", name: "Write", arguments: { content: "pending" } },
		]);

		source.emit(
			"session-1",
			assistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: "pending", partial }, 1),
		);
		first.dispose();
		secondActive = false;
		vi.advanceTimersByTime(50);

		expect(firstOutput).toEqual([]);
		expect(secondOutput).toEqual([]);
		expect(source.listenerCount("session-1")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disposes a live-looking subscription when its frame rejects a timed send", () => {
		vi.useFakeTimers();
		const source = new FakeRuntimeEventSource();
		const emit = vi.fn(() => {
			throw new Error("Render frame was disposed before WebFrameMain could be accessed");
		});
		createSessionEventIpcSubscription({ source, sessionId: "session-1", isActive: () => true, emit });
		const event = assistantEvent(
			{
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "pending",
				partial: assistantMessage([{ type: "toolCall", id: "write-1", name: "Write", arguments: {} }]),
			},
			1,
		);
		source.emit("session-1", event);
		expect(() => vi.advanceTimersByTime(50)).not.toThrow();
		expect(emit).toHaveBeenCalledTimes(1);
		expect(source.listenerCount("session-1")).toBe(0);
		source.emit("session-1", event);
		vi.advanceTimersByTime(50);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
