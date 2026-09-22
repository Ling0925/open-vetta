import type { AssistantSessionEvent, SessionEvent } from "@vetta/runtime-core";

export const TOOL_CALL_DELTA_MAX_BATCH_DELAY_MS = 50;

type ToolCallDeltaEvent = Extract<AssistantSessionEvent, { type: "toolcall_delta" }>;

interface ToolCallDeltaKey {
	readonly sessionId: string;
	readonly turnId: string | undefined;
	readonly modelCallIndex: number;
	readonly contentIndex: number;
	readonly toolCallId: string | undefined;
}

interface PendingToolCallDelta {
	readonly key: ToolCallDeltaKey;
	latest: ToolCallDeltaEvent;
	readonly deltas: string[];
}

export interface ToolCallDeltaTransportMergerOptions {
	/**
	 * Must consume or snapshot the event synchronously if it retains the payload.
	 * Electron's WebContents.send does this through structured clone.
	 */
	readonly emit: (event: SessionEvent) => void;
	readonly maxDelayMs?: number;
}

function isToolCallDelta(event: SessionEvent): event is ToolCallDeltaEvent {
	return event.channel === "assistant" && event.type === "toolcall_delta";
}

function keyFor(event: ToolCallDeltaEvent): ToolCallDeltaKey {
	const content = event.partial.content[event.contentIndex];
	return {
		sessionId: event.sessionId,
		turnId: event.turnId,
		modelCallIndex: event.modelCallIndex,
		contentIndex: event.contentIndex,
		toolCallId: content?.type === "toolCall" ? content.id : undefined,
	};
}

function sameKey(left: ToolCallDeltaKey, right: ToolCallDeltaKey): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.modelCallIndex === right.modelCallIndex &&
		left.contentIndex === right.contentIndex &&
		left.toolCallId === right.toolCallId
	);
}

/**
 * Losslessly coalesces adjacent tool-call argument deltas at the Desktop display
 * transport boundary. All non-matching events synchronously flush the pending
 * delta first, preserving the Runtime event order.
 *
 * Upstream adapters may mutate and reuse `partial`. The merger deliberately
 * keeps only the latest reference while a batch is open; the synchronous emit
 * boundary takes the renderer-visible display snapshot once per batch. The
 * snapshot can therefore include the newest parsed arguments available at
 * flush time, while `delta` remains the lossless concatenation of every input.
 */
export class ToolCallDeltaTransportMerger {
	readonly #emit: (event: SessionEvent) => void;
	readonly #maxDelayMs: number;
	#pending: PendingToolCallDelta | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;
	#draining = false;
	// null is an ordered explicit flush; callbacks may synchronously reenter push/flush.
	readonly #queue: Array<SessionEvent | null> = [];

	constructor(options: ToolCallDeltaTransportMergerOptions) {
		this.#emit = options.emit;
		this.#maxDelayMs = options.maxDelayMs ?? TOOL_CALL_DELTA_MAX_BATCH_DELAY_MS;
	}

	push(event: SessionEvent): void {
		this.#enqueue(event);
	}

	flush(): void {
		this.#enqueue(null);
	}

	#enqueue(event: SessionEvent | null): void {
		if (this.#disposed) return;
		this.#queue.push(event);
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (!this.#disposed && this.#queue.length > 0) {
				const next = this.#queue.shift();
				if (next === null) this.#flushPending();
				else if (next !== undefined) this.#consume(next);
			}
		} finally {
			this.#draining = false;
		}
	}

	#consume(event: SessionEvent): void {
		if (!isToolCallDelta(event)) {
			this.#flushPending();
			if (!this.#disposed) this.#emit(event);
			return;
		}

		const key = keyFor(event);
		if (this.#pending && sameKey(this.#pending.key, key)) {
			this.#pending.latest = event;
			this.#pending.deltas.push(event.delta);
			return;
		}

		this.#flushPending();
		if (this.#disposed) return;
		this.#pending = { key, latest: event, deltas: [event.delta] };
		this.#timer = setTimeout(() => this.flush(), this.#maxDelayMs);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = undefined;
		this.#queue.length = 0;
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending || this.#disposed) return;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = undefined;
		this.#emit({ ...pending.latest, delta: pending.deltas.join("") });
	}
}
