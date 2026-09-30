import type { Message } from "@vetta/ai";
import type {
	QueuedInputAdmission,
	QueuedSessionInput,
	SessionStreamingBehavior,
	TurnInputQueue,
} from "./contracts.js";
import { KERNEL_ERROR_CODES, KernelError } from "./errors.js";

export interface PreparedQueuedInputBatch {
	readonly messages: Message[];
	commit(admission: QueuedInputAdmission): Promise<void>;
}

/** Keep queued identities until complete inputs are durably admitted. */
export async function consumeQueuedInputBatch(
	queue: TurnInputQueue,
	behavior: SessionStreamingBehavior,
	prepare: (inputs: readonly QueuedSessionInput[]) => Promise<Message[] | PreparedQueuedInputBatch>,
	signal: AbortSignal,
): Promise<Message[]> {
	signal.throwIfAborted();
	const reservation = behavior === "steer" ? queue.reserveSteeringInputs?.() : queue.reserveFollowUpInputs?.();
	if (!reservation) {
		const inputs = behavior === "steer" ? queue.takeSteeringInputs?.() : queue.takeFollowUpInputs?.();
		if (!inputs) return [...(behavior === "steer" ? queue.takeSteering() : queue.takeFollowUps())];
		const prepared = await prepare(inputs);
		if (Array.isArray(prepared)) return prepared;
		await prepared.commit({ assertPending: () => signal.throwIfAborted(), commit: () => {} });
		return prepared.messages;
	}
	const release = () => reservation.release();
	signal.addEventListener("abort", release, { once: true });
	try {
		signal.throwIfAborted();
		const prepared = reservation.inputs.length > 0 ? await prepare(reservation.inputs) : [];
		signal.throwIfAborted();
		if (!reservation.isValid()) {
			throw new KernelError(KERNEL_ERROR_CODES.TURN_INTERRUPTED, "Queued input changed during preparation");
		}
		if (!Array.isArray(prepared)) {
			// Once durable admission begins, abort cannot make the same input consumable again.
			// A late cancellation still stops execution, but the complete input remains in history.
			signal.removeEventListener("abort", release);
			let committed = false;
			const commit = () => {
				if (committed) return;
				if (!reservation.commit()) {
					throw new KernelError(
						KERNEL_ERROR_CODES.TURN_INTERRUPTED,
						"Queued input changed during durable admission",
					);
				}
				committed = true;
			};
			await prepared.commit({
				assertPending: () => {
					signal.throwIfAborted();
					if (!reservation.isValid()) {
						throw new KernelError(KERNEL_ERROR_CODES.TURN_INTERRUPTED, "Queued input changed before admission");
					}
				},
				commit,
			});
			commit();
			return prepared.messages;
		}
		if (!reservation.commit()) {
			throw new KernelError(KERNEL_ERROR_CODES.TURN_INTERRUPTED, "Queued input changed during preparation");
		}
		return prepared;
	} finally {
		signal.removeEventListener("abort", release);
		release();
	}
}
