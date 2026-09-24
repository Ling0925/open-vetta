import type { Message } from "@vetta/ai";
import type { QueuedSessionInput, SessionStreamingBehavior, TurnInputQueue } from "./contracts.js";
import { KERNEL_ERROR_CODES, KernelError } from "./errors.js";

/** Keep queued identities until asynchronous preparation succeeds. Legacy queues retain their existing contract. */
export async function consumeQueuedInputBatch(
	queue: TurnInputQueue,
	behavior: SessionStreamingBehavior,
	prepare: (inputs: readonly QueuedSessionInput[]) => Promise<Message[]>,
	signal: AbortSignal,
): Promise<Message[]> {
	signal.throwIfAborted();
	const reservation = behavior === "steer" ? queue.reserveSteeringInputs?.() : queue.reserveFollowUpInputs?.();
	if (!reservation) {
		const inputs = behavior === "steer" ? queue.takeSteeringInputs?.() : queue.takeFollowUpInputs?.();
		return inputs ? prepare(inputs) : [...(behavior === "steer" ? queue.takeSteering() : queue.takeFollowUps())];
	}
	const release = () => reservation.release();
	signal.addEventListener("abort", release, { once: true });
	try {
		signal.throwIfAborted();
		const messages = reservation.inputs.length > 0 ? await prepare(reservation.inputs) : [];
		signal.throwIfAborted();
		if (!reservation.commit()) {
			throw new KernelError(KERNEL_ERROR_CODES.TURN_INTERRUPTED, "Queued input changed during preparation");
		}
		return messages;
	} finally {
		signal.removeEventListener("abort", release);
		release();
	}
}
