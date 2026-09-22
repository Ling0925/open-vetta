import type { SessionEvent } from "@vetta/runtime-core";
import { slimSessionEventForIpc } from "./slim-session-event-for-ipc.js";
import { ToolCallDeltaTransportMerger } from "./tool-call-delta-transport-merger.js";

export interface SessionEventSubscriptionSource {
	subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;
}

export interface SessionEventIpcSubscription {
	/** Sends a host-created snapshot through the same ordered transport. */
	push(event: SessionEvent): void;
	dispose(): void;
}

export interface SessionEventIpcSubscriptionOptions {
	readonly source: SessionEventSubscriptionSource;
	readonly sessionId: string;
	readonly isActive: () => boolean;
	readonly emit: (event: SessionEvent) => void;
	readonly observe?: (event: SessionEvent) => void;
	readonly onDeliveryError?: (error: unknown) => void;
}

/**
 * Owns one Runtime-to-Renderer display subscription. Runtime events stay
 * unchanged; only the final Desktop IPC display boundary slims and batches
 * their transport representation.
 */
export function createSessionEventIpcSubscription(
	options: SessionEventIpcSubscriptionOptions,
): SessionEventIpcSubscription {
	let disposed = false;
	let unsubscribeSource: (() => void) | undefined;
	const transport = new ToolCallDeltaTransportMerger({
		emit: (event) => {
			if (disposed) return;
			if (!options.isActive()) {
				dispose();
				return;
			}
			try {
				options.emit(slimSessionEventForIpc(event));
			} catch (error) {
				// A disposed frame can reject send before WebContents reports destroyed.
				// Timed flushes no longer run inside Runtime's listener error boundary.
				dispose();
				options.onDeliveryError?.(error);
			}
		},
	});

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		transport.dispose();
		unsubscribeSource?.();
	}
	const push = (event: SessionEvent): void => {
		if (disposed) return;
		if (!options.isActive()) {
			dispose();
			return;
		}
		transport.push(event);
	};

	unsubscribeSource = options.source.subscribe(options.sessionId, (event) => {
		if (disposed) return;
		options.observe?.(event);
		push(event);
	});
	// A source may synchronously emit while subscribe is installing its cleanup.
	if (disposed) unsubscribeSource();

	return { push, dispose };
}
