import type { AssistantMessage, Message } from "@vetta/ai";
import type { RuntimeMessageEnvelope } from "../runtime-execution-observation.js";
import type {
	RuntimeSnapshot,
	RuntimeTurnModelBinding,
	TurnEngineContextCheckpointHandler,
	TurnEngineContextCheckpointRequest,
	TurnEngineContextCheckpointResult,
} from "./contracts.js";

export interface RuntimeModelCallCheckpointInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly snapshot: RuntimeSnapshot;
	readonly modelBinding?: RuntimeTurnModelBinding;
	readonly checkpoint?: TurnEngineContextCheckpointHandler;
	readonly messages: readonly Message[];
	readonly messageEnvelopes?: readonly RuntimeMessageEnvelope[];
	readonly reason: TurnEngineContextCheckpointRequest["reason"];
	readonly modelCallIndex?: number;
	readonly assistantMessage?: AssistantMessage;
	readonly recoveryAttempt: number;
	readonly signal: AbortSignal;
}

/**
 * Backend-neutral Vetta Context Plane boundary before a model call.
 *
 * Both Native and external execution loops must use this helper instead of
 * independently ordering transform and durable checkpoint/compaction.
 */
export async function prepareRuntimeModelCallCheckpoint(
	input: RuntimeModelCallCheckpointInput,
): Promise<TurnEngineContextCheckpointResult | undefined> {
	input.signal.throwIfAborted();
	let messages = [...input.messages];
	if (input.reason === "model_call" && input.snapshot.modelCallContextTransformer && input.modelBinding) {
		messages = [
			...(await input.snapshot.modelCallContextTransformer.transform(
				{
					sessionId: input.sessionId,
					turnId: input.turnId,
					messages,
					...(input.messageEnvelopes ? { messageEnvelopes: input.messageEnvelopes } : {}),
					modelBinding: input.modelBinding,
				},
				input.signal,
			)),
		];
		input.signal.throwIfAborted();
	}

	const result = await input.checkpoint?.(
		{
			reason: input.reason,
			messages,
			...(input.modelCallIndex === undefined ? {} : { modelCallIndex: input.modelCallIndex }),
			...(input.assistantMessage === undefined ? {} : { assistantMessage: input.assistantMessage }),
			recoveryAttempt: input.recoveryAttempt,
		},
		input.signal,
	);
	input.signal.throwIfAborted();
	if (!result) return input.reason === "model_call" ? { messages } : undefined;
	return result;
}

export interface RuntimeModelCallFinalizationInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly snapshot: RuntimeSnapshot;
	readonly modelBinding?: RuntimeTurnModelBinding;
	readonly messages: readonly Message[];
	readonly signal: AbortSignal;
}

/** Backend-neutral final model-visible message pass after checkpoint/compaction. */
export async function finalizeRuntimeModelCallMessages(
	input: RuntimeModelCallFinalizationInput,
): Promise<readonly Message[]> {
	input.signal.throwIfAborted();
	if (!input.snapshot.modelCallMessageFinalizer || !input.modelBinding) return input.messages;
	const messages = await input.snapshot.modelCallMessageFinalizer.finalize(
		{
			sessionId: input.sessionId,
			turnId: input.turnId,
			messages: input.messages,
			modelBinding: input.modelBinding,
		},
		input.signal,
	);
	input.signal.throwIfAborted();
	return messages;
}
