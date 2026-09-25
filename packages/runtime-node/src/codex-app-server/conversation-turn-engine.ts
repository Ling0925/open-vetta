import type { Message } from "@vetta/ai";
import type { RuntimeSessionObservationEvent } from "@vetta/runtime-core";
import type { TurnEngineEvent, TurnEnginePort, TurnEngineRequest } from "@vetta/runtime-core/kernel";
import { codexConversationInput } from "./conversation-context.js";
import type { CodexHostEvent } from "./host-contracts.js";
import { CodexHostProjection } from "./host-projection.js";
import type { CodexAppServerSession } from "./session.js";
import { CodexTurnEventBuffer } from "./turn-event-buffer.js";
import { CodexRuntimeError } from "./types.js";

export interface CodexTurnConnection {
	readonly session: CodexAppServerSession;
	/** Also revokes the gateway and waits for owned process cleanup. */
	close(): Promise<void>;
}
export type CodexTurnConnector = (request: TurnEngineRequest) => Promise<CodexTurnConnection>;

/** Codex owns the entire model/tool loop for this turn. The existing Kernel remains
 * the only owner of user input, journal commits and the application conversation. */
export class CodexConversationTurnEngine implements TurnEnginePort {
	private readonly blocked = new Set<string>();
	constructor(private readonly connect: CodexTurnConnector) {}

	assertReusable(sessionId: string): void {
		if (this.blocked.has(sessionId))
			throw new CodexRuntimeError("CLEANUP_UNCONFIRMED", "The previous Codex process could not be confirmed closed");
	}

	async *execute(request: TurnEngineRequest): AsyncGenerator<TurnEngineEvent> {
		this.assertReusable(request.sessionId);
		const text = codexConversationInput(request);
		const consumer = new AbortController();
		const signal = AbortSignal.any([request.signal, consumer.signal]);
		const events = new CodexTurnEventBuffer();
		const producer = this.produce({ ...request, signal }, text, events);
		// Install the rejection handler immediately; the consumer may be awaiting persistence.
		void producer.catch(() => undefined);
		try {
			while (true) {
				const next = await events.next();
				if (next.done) break;
				yield next.value;
			}
		} finally {
			// Returning/throwing out of the host pipeline must not orphan the external loop.
			consumer.abort();
			await producer;
		}
	}

	private async produce(request: TurnEngineRequest, text: string, events: CodexTurnEventBuffer): Promise<void> {
		let connection: CodexTurnConnection | undefined;
		let unsubscribe: (() => void) | undefined;
		let stop: Promise<void> | undefined;
		let failure: unknown;
		let projectionFailure: unknown;
		const signal = request.signal;
		const cancel = () => {
			if (!connection) return;
			stop ??= connection.session.interrupt();
			void stop.catch(() => undefined);
		};
		try {
			signal.throwIfAborted();
			events.push(observation({ type: "lifecycle", phase: "agent_start", source: "runtime-core" }));
			events.push(observation({ type: "lifecycle", phase: "turn_start", source: "runtime-core" }));
			connection = await this.connect(request);
			signal.throwIfAborted();
			const session = connection.session;
			const projection = new CodexHostProjection(request.sessionId, session.threadId);
			const emitted = new Map<string, string>();
			const emitMessage = (id: string, message: Message) => {
				if (message.role === "user") return;
				message = canonicalToolNames(message);
				// Timestamps may become authoritative on refresh; semantic contents must agree.
				const signature = JSON.stringify({ role: message.role, content: message.content });
				const previous = emitted.get(id);
				if (previous !== undefined) {
					if (previous !== signature)
						throw new CodexRuntimeError(
							"HISTORY_MISMATCH",
							"Codex final history disagrees with its streamed result",
						);
					return;
				}
				emitted.set(id, signature);
				events.push({ type: "message", message });
				events.push(observation({ type: "message.final", message, source: "runtime-core" }));
			};
			unsubscribe = session.subscribe((event) => {
				if (projectionFailure) return;
				try {
					for (const projected of projection.accept(event)) {
						if (projected.type === "message.final") {
							// Call and result share a Codex item but are distinct canonical messages.
							const id = JSON.stringify([
								projected.codex.turnId,
								projected.codex.itemId,
								projected.message.role,
							]);
							emitMessage(id, projected.message);
						} else {
							const mapped = mapObservation(projected);
							if (mapped) events.push(observation(mapped));
						}
					}
				} catch (error) {
					projectionFailure = error;
					cancel();
				}
			});
			signal.addEventListener("abort", cancel, { once: true });
			signal.throwIfAborted();
			const turn = await session.startTurn({ text, inputId: request.turnId });
			if (signal.aborted) cancel();
			const terminal = await turn.completed;
			if (stop) await stop;
			if (projectionFailure) throw projectionFailure;
			if (!signal.aborted) {
				// Reconcile missing notifications against actual authority before reporting completion.
				projection.replaceHistory(await session.refreshHistory());
				for (const row of projection.readHistory()) {
					if (row.type !== "message" || row.message.role === "user") continue;
					// IDs are encoded by the projection; bind reconciliation to the same item identity.
					const match = row.entryId?.match(/^codex:[^:]+:([^:]+):([^:]+)(?::(?:call|result))?$/);
					if (!match) throw new CodexRuntimeError("HISTORY_IDENTITY", "Codex returned an uncorrelated message");
					emitMessage(
						JSON.stringify([decodeURIComponent(match[1]), decodeURIComponent(match[2]), row.message.role]),
						row.message,
					);
				}
			}
			if (terminal.status === "failed")
				throw new CodexRuntimeError(
					"CODEX_TURN_FAILED",
					"Codex could not complete this turn; no automatic retry was made",
				);
			if (terminal.status === "interrupted" && !signal.aborted) {
				throw new CodexRuntimeError("CODEX_INTERRUPTED", "Codex interrupted the turn before completing it");
			}
		} catch (error) {
			failure = error;
		} finally {
			signal.removeEventListener("abort", cancel);
			unsubscribe?.();
			try {
				await connection?.close();
			} catch {
				this.blocked.add(request.sessionId);
				failure = new CodexRuntimeError(
					"CLEANUP_UNCONFIRMED",
					"Codex cleanup could not be confirmed; another backend must not start",
				);
			}
			if (failure instanceof CodexRuntimeError && failure.code === "CLEANUP_UNCONFIRMED")
				this.blocked.add(request.sessionId);
			try {
				if (failure === undefined && !signal.aborted) {
					events.push(observation({ type: "lifecycle", phase: "turn_end", source: "runtime-core" }));
					events.push(observation({ type: "lifecycle", phase: "agent_end", source: "runtime-core" }));
					events.push({ type: "completed", stopReason: "stop" });
				}
			} catch (error) {
				failure = error;
			} finally {
				events.finish(failure ?? (signal.aborted ? signal.reason : undefined));
			}
		}
	}
}

function observation(value: RuntimeSessionObservationEvent): TurnEngineEvent {
	return { type: "observation", observation: value };
}
function mapObservation(event: CodexHostEvent): RuntimeSessionObservationEvent | undefined {
	switch (event.type) {
		case "message.delta":
			return { type: event.type, delta: event.delta, source: "runtime-core" };
		case "tool.start":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: safeToolName(event.toolName),
				args: event.args,
				startedAt: event.startedAt,
				source: "runtime-core",
			};
		case "tool.update":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: safeToolName(event.toolName),
				partialResult: event.partialResult,
				source: "runtime-core",
			};
		case "tool.end":
			return {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: safeToolName(event.toolName),
				isError: event.isError,
				result: event.result,
				startedAt: event.startedAt,
				durationMs: event.durationMs,
				phases: event.phases,
				source: "runtime-core",
			};
		default:
			return undefined;
	}
}

function safeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
/** Original conversations can later be sent through other model protocols. Historical
 * tool names must remain valid identifiers, not preview-only dotted display labels. */
function canonicalToolNames(message: Message): Message {
	if (message.role === "assistant")
		return {
			...message,
			content: message.content.map((block) =>
				block.type === "toolCall" ? { ...block, name: safeToolName(block.name) } : block,
			),
		};
	if (message.role === "toolResult") return { ...message, toolName: safeToolName(message.toolName) };
	return message;
}
