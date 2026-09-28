import type { TurnEngineEvent } from "@vetta/runtime-core/kernel";
import { deferred } from "./protocol.js";
import { CodexRuntimeError } from "./types.js";

const MAX_EVENTS = 512;
const MAX_BYTES = 4 * 1024 * 1024;

/** Bounded producer/consumer boundary between stdio notifications and journal writes. */
export class CodexTurnEventBuffer {
	private readonly events: TurnEngineEvent[] = [];
	private bytes = 0;
	private changed = deferred<void>();
	private ended = false;
	private failure: unknown;
	push(event: TurnEngineEvent): void {
		if (this.ended) return;
		const size = eventSize(event);
		const updateId = toolUpdateId(event);
		const lastIndex = this.events.length - 1;
		const previous = lastIndex >= 0 ? this.events[lastIndex] : undefined;
		if (updateId && previous && toolUpdateId(previous) === updateId) {
			const previousSize = eventSize(previous);
			const nextBytes = this.bytes - previousSize + size;
			if (nextBytes > MAX_BYTES) throw backpressure();
			this.events[lastIndex] = event;
			this.bytes = nextBytes;
			this.wake();
			return;
		}
		if (this.events.length >= MAX_EVENTS || this.bytes + size > MAX_BYTES) throw backpressure();
		this.events.push(event);
		this.bytes += size;
		this.wake();
	}
	finish(error?: unknown): void {
		if (this.ended) return;
		this.ended = true;
		this.failure = error;
		this.wake();
	}
	async next(): Promise<IteratorResult<TurnEngineEvent>> {
		while (true) {
			const event = this.events.shift();
			if (event) {
				this.bytes -= eventSize(event);
				return { done: false, value: event };
			}
			if (this.ended) {
				if (this.failure !== undefined) throw this.failure;
				return { done: true, value: undefined };
			}
			await this.changed.promise;
		}
	}
	private wake(): void {
		const previous = this.changed;
		this.changed = deferred<void>();
		previous.resolve();
	}
}

function eventSize(event: TurnEngineEvent): number {
	return Buffer.byteLength(JSON.stringify(event));
}

function toolUpdateId(event: TurnEngineEvent): string | undefined {
	return event.type === "observation" && event.observation.type === "tool.update"
		? event.observation.toolCallId
		: undefined;
}

function backpressure(): CodexRuntimeError {
	return new CodexRuntimeError("EVENT_BACKPRESSURE", "Codex output exceeded the host persistence buffer");
}
