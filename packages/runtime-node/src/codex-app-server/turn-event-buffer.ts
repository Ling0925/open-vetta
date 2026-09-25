import type { TurnEngineEvent } from "@vetta/runtime-core/kernel";
import { deferred } from "./protocol.js";
import { CodexRuntimeError } from "./types.js";

/** Bounded producer/consumer boundary between stdio notifications and journal writes. */
export class CodexTurnEventBuffer {
	private readonly events: TurnEngineEvent[] = [];
	private bytes = 0;
	private changed = deferred<void>();
	private ended = false;
	private failure: unknown;
	push(event: TurnEngineEvent): void {
		if (this.ended) return;
		const size = Buffer.byteLength(JSON.stringify(event));
		if (this.events.length >= 512 || this.bytes + size > 4 * 1024 * 1024) {
			throw new CodexRuntimeError("EVENT_BACKPRESSURE", "Codex output exceeded the host persistence buffer");
		}
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
				this.bytes -= Buffer.byteLength(JSON.stringify(event));
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
