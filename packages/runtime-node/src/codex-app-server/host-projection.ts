import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, ToolResultMessage } from "@vetta/ai";
import type { HistoryEntry, SessionEvent, SessionEventBase } from "@vetta/runtime-core";
import type { CodexHostEvent } from "./host-contracts.js";
import { object, readTurn, text } from "./protocol.js";
import { CodexRuntimeError, type CodexSessionEvent, type CodexThread, type CodexTurn, type JsonObject } from "./types.js";

interface ItemState {
	value: JsonObject;
	final: boolean;
	startedAt: number;
}
interface TurnState {
	id: string;
	status: CodexTurn["status"];
	timestamp: number;
	items: Map<string, ItemState>;
	error?: unknown;
}
type EventPayload<T> = T extends SessionEvent ? Omit<T, keyof SessionEventBase> : never;
const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"]);
const toolName = (item: JsonObject) => `codex.${String(item.type)}`;
const messageId = (thread: string, turn: string, item: string) =>
	`codex:${encodeURIComponent(thread)}:${encodeURIComponent(turn)}:${encodeURIComponent(item)}`;
function seconds(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000) {
		throw new CodexRuntimeError("PROTOCOL", "Invalid Codex turn timestamp");
	}
	return value * 1000;
}
const plain = (value: unknown) => typeof value === "string" ? value : "";

/** Display-only compatibility projection. These messages must never be submitted to the Native loop/accounting. */
function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant", content, timestamp, api: "codex-app-server", provider: "codex-runtime", model: "codex-managed",
		stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cacheUsageReporting: "unavailable", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** One ID-keyed projection for live events and restored Codex items; no transcript is written here. */
export class CodexHostProjection {
	private readonly turns = new Map<string, TurnState>();
	private instance?: string;
	private sequence = 0;
	private activeTurnId?: string;
	constructor(private readonly sessionId: string, private readonly threadId: string) {}

	replaceHistory(thread: CodexThread): void {
		if (thread.id !== this.threadId) throw new CodexRuntimeError("PROTOCOL", "Codex history belongs to another thread");
		const next = new Map<string, TurnState>();
		for (const value of thread.turns) {
			const turn = readTurn(value);
			if (value.itemsView !== undefined && value.itemsView !== "full") {
				throw new CodexRuntimeError("HISTORY_INCOMPLETE", "Codex returned an incomplete history; do not present it as empty");
			}
			if (turn.status === "inProgress" || next.has(turn.id)) {
				throw new CodexRuntimeError("RECOVERY_REQUIRED", "Codex history contains an active or duplicate turn");
			}
			const state: TurnState = { id: turn.id, status: turn.status, timestamp: seconds(value.startedAt),
				items: new Map(), error: turn.error };
			for (const item of turn.items) {
				const id = text(item.id, "item.id");
				if (state.items.has(id)) throw new CodexRuntimeError("PROTOCOL", "Duplicate item in Codex history");
				validateItem(item);
				state.items.set(id, { value: structuredClone(item), final: true, startedAt: state.timestamp });
			}
			next.set(turn.id, state);
		}
		this.turns.clear();
		for (const [id, turn] of next) this.turns.set(id, turn);
		this.activeTurnId = undefined;
	}

	accept(event: CodexSessionEvent): CodexHostEvent[] {
		if (event.threadId !== this.threadId) return [];
		if (this.instance !== undefined && this.instance !== event.instanceId) {
			throw new CodexRuntimeError("PROTOCOL", "A Codex projection cannot mix process generations");
		}
		this.instance = event.instanceId;
		if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new CodexRuntimeError("PROTOCOL", "Invalid Codex event sequence");
		if (event.sequence <= this.sequence) return [];
		this.sequence = event.sequence;
		const { method, params } = event;
		if (method === "runtime/state") {
			if ((params.state === "running" || params.state === "cancelling") && typeof params.turnId === "string") {
				return this.begin(params.turnId);
			}
			return [];
		}
		if (method === "turn/started") return this.begin(text(object(params.turn).id, "turn.id"));
		if (method === "turn/completed") return this.finish(readTurn(params.turn));
		const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
		const turn = turnId ? this.turns.get(turnId) : undefined;
		if (!turn || turn.status !== "inProgress" || turnId !== this.activeTurnId) return [];
		if (method === "item/started" || method === "item/completed") {
			return this.item(turn, object(params.item), method === "item/completed");
		}
		if (method === "item/agentMessage/delta") {
			const id = text(params.itemId, "itemId");
			const delta = plain(params.delta);
			const old = turn.items.get(id);
			if (old?.final) return [];
			if (old && old.value.type !== "agentMessage") throw new CodexRuntimeError("PROTOCOL", "Item type changed during streaming");
			turn.items.set(id, { value: { ...(old?.value ?? { id, type: "agentMessage" }), text: plain(old?.value.text) + delta },
				final: false, startedAt: old?.startedAt ?? Date.now() });
			return [this.event({ type: "message.delta", delta }, turn.id, id)];
		}
		if (method === "item/commandExecution/outputDelta") {
			const id = text(params.itemId, "itemId");
			const slot = turn.items.get(id);
			if (!slot || slot.final || slot.value.type !== "commandExecution") return [];
			slot.value = { ...slot.value, aggregatedOutput: plain(slot.value.aggregatedOutput) + plain(params.delta) };
			return [this.event({ type: "tool.update", toolCallId: id, toolName: toolName(slot.value),
				partialResult: { content: [{ type: "text", text: plain(slot.value.aggregatedOutput) }] } }, turn.id, id)];
		}
		return [];
	}

	readHistory(): HistoryEntry[] {
		const entries: HistoryEntry[] = [];
		for (const turn of this.turns.values()) {
			for (const [id, slot] of turn.items) entries.push(...this.historyItem(turn, id, slot));
			if (turn.status === "failed") entries.push({ type: "error", code: "CODEX_TURN_FAILED", retryable: false,
				origin: "runtime", turnId: turn.id, entryId: `codex-error:${turn.id}`, message: this.errorText(turn.error),
				timestamp: new Date(turn.timestamp).toISOString() });
			if (turn.status === "interrupted") entries.push({ type: "custom_marker", customType: "codex.turn.interrupted",
				details: { threadId: this.threadId, turnId: turn.id }, timestamp: new Date(turn.timestamp).toISOString() });
		}
		return structuredClone(entries);
	}

	readMessages(): Message[] {
		return this.readHistory().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
	}

	readCursor(): { instanceId?: string; sequence: number } {
		return { ...(this.instance ? { instanceId: this.instance } : {}), sequence: this.sequence };
	}

	readActiveTools(): string[] {
		const turn = this.activeTurnId ? this.turns.get(this.activeTurnId) : undefined;
		return turn ? [...new Set([...turn.items.values()].filter((slot) => !slot.final && TOOL_TYPES.has(String(slot.value.type)))
			.map((slot) => toolName(slot.value)))] : [];
	}

	failure(error: unknown): CodexHostEvent[] {
		const turnId = this.activeTurnId;
		if (turnId) {
			const turn = this.turns.get(turnId);
			if (turn) { turn.status = "failed"; turn.error = { message: this.errorText(error) }; }
		}
		this.activeTurnId = undefined;
		return [this.event({ type: "error", ...(turnId ? { turnId } : {}), error: {
			code: error instanceof CodexRuntimeError ? error.code : "CODEX_RUNTIME_FAILED", message: this.errorText(error),
			retryable: false, origin: "runtime" } }, turnId), this.lifecycle("agent_end", turnId)];
	}

	private begin(id: string): CodexHostEvent[] {
		const old = this.turns.get(id);
		if (old) return [];
		if (this.activeTurnId) throw new CodexRuntimeError("PROTOCOL", "Overlapping Codex turns");
		this.activeTurnId = id;
		this.turns.set(id, { id, status: "inProgress", items: new Map(), timestamp: Date.now() });
		return [this.lifecycle("agent_start", id), this.lifecycle("turn_start", id)];
	}

	private item(turn: TurnState, value: JsonObject, final: boolean): CodexHostEvent[] {
		validateItem(value);
		const id = text(value.id, "item.id");
		const type = text(value.type, "item.type");
		const old = turn.items.get(id);
		if (old?.final || old && !final) return [];
		if (old && old.value.type !== type) throw new CodexRuntimeError("PROTOCOL", "Codex item type changed");
		const slot: ItemState = { value: structuredClone(value), final, startedAt: old?.startedAt ?? Date.now() };
		turn.items.set(id, slot);
		const events: CodexHostEvent[] = [];
		if (TOOL_TYPES.has(type) && !old) events.push(this.event({ type: "tool.start", toolCallId: id,
			toolName: toolName(value), args: structuredClone(value), startedAt: slot.startedAt }, turn.id, id));
		if (!final) return events;
		if (TOOL_TYPES.has(type)) {
			const result = this.toolResult(slot);
			events.push(this.event({ type: "tool.end", toolCallId: id, toolName: toolName(value), isError: result.isError,
				result, startedAt: slot.startedAt, durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
				phases: [] }, turn.id, id));
		}
		for (const entry of this.historyItem(turn, id, slot)) {
			if (entry.type === "message") events.push(this.event({ type: "message.final", message: entry.message }, turn.id, id));
		}
		return events;
	}

	private finish(value: CodexTurn): CodexHostEvent[] {
		const turn = this.turns.get(value.id);
		if (!turn || turn.status !== "inProgress" || value.id !== this.activeTurnId) return [];
		if (value.status === "inProgress") throw new CodexRuntimeError("PROTOCOL", "Nonterminal Codex completion");
		const events: CodexHostEvent[] = [];
		// itemsView may be notLoaded/summary; never replace complete streamed items with a sparse terminal payload.
		const view = object(value).itemsView;
		if (view === undefined || view === "full") {
			for (const item of value.items) {
				const old = turn.items.get(text(item.id, "item.id"));
				if (!old?.final) events.push(...this.item(turn, item, true));
			}
		}
		turn.status = value.status;
		turn.error = value.error;
		this.activeTurnId = undefined;
		if (value.status === "failed") events.push(this.event({ type: "error", turnId: turn.id, error: {
			code: "CODEX_TURN_FAILED", message: this.errorText(value.error), retryable: false, origin: "runtime" } }, turn.id));
		events.push(this.lifecycle("turn_end", turn.id));
		if (value.status === "interrupted") events.push(this.lifecycle("aborted", turn.id));
		events.push(this.lifecycle("agent_end", turn.id));
		return events;
	}

	private historyItem(turn: TurnState, id: string, slot: ItemState): HistoryEntry[] {
		const item = slot.value;
		const entryId = messageId(this.threadId, turn.id, id);
		const wrap = (message: Message): HistoryEntry => ({ type: "message", entryId, message });
		if (item.type === "userMessage") {
			if (!Array.isArray(item.content)) throw new CodexRuntimeError("PROTOCOL", "Invalid user item content");
			const blocks = item.content.map(object);
			if (blocks.every((block) => block.type === "text")) {
				return [wrap({ role: "user", content: blocks.map((block) => plain(block.text)).join("\n"), timestamp: turn.timestamp })];
			}
		}
		if (item.type === "agentMessage" || item.type === "plan") return [wrap(assistant([{ type: "text", text: plain(item.text) }], turn.timestamp))];
		if (item.type === "reasoning") {
			const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === "string").join("\n") : "";
			return [wrap(assistant([{ type: "thinking", thinking: summary }], turn.timestamp))];
		}
		if (TOOL_TYPES.has(String(item.type))) {
			const call = assistant([{ type: "toolCall", id, name: toolName(item), arguments: { ...item } }], turn.timestamp);
			call.stopReason = "toolUse";
			const entries: HistoryEntry[] = [{ type: "message", entryId: `${entryId}:call`, message: call }];
			if (slot.final) entries.push({ type: "message", entryId: `${entryId}:result`, message: this.toolResult(slot) });
			return entries;
		}
		return [{ type: "custom_marker", customType: "codex.item", details: { entryId, threadId: this.threadId,
			turnId: turn.id, item: structuredClone(item), final: slot.final }, timestamp: new Date(turn.timestamp).toISOString() }];
	}

	private toolResult(slot: ItemState): ToolResultMessage {
		const item = slot.value;
		const success = item.status === "completed" && item.error == null && item.success !== false &&
			(item.type !== "commandExecution" || item.exitCode === 0);
		return { role: "toolResult", toolCallId: String(item.id), toolName: toolName(item), timestamp: slot.startedAt,
			content: [{ type: "text", text: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : JSON.stringify(item) }],
			details: { runtime: "codex-app-server", item: structuredClone(item), outcome: success ? "completed" : "failed-or-unknown" }, isError: !success };
	}

	private lifecycle(phase: "agent_start" | "turn_start" | "turn_end" | "agent_end" | "aborted", turnId?: string): CodexHostEvent {
		return this.event({ type: "session.lifecycle", phase }, turnId);
	}

	private event(value: EventPayload<SessionEvent>, turnId?: string, itemId?: string): CodexHostEvent;
	private event(value: object, turnId?: string, itemId?: string): CodexHostEvent {
		return { schemaVersion: 1, channel: "runtime", source: "runtime-core", sessionId: this.sessionId,
			eventId: randomUUID(), timestamp: Date.now(), ...value,
			codex: { threadId: this.threadId, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) } } as CodexHostEvent;
	}

	private errorText(error: unknown): string {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return "Codex execution failed; inspect the authoritative thread before retrying";
	}
}

function validateItem(item: JsonObject): void {
	text(item.id, "item.id");
	text(item.type, "item.type");
	if ((item.type === "agentMessage" || item.type === "plan") && typeof item.text !== "string") {
		throw new CodexRuntimeError("PROTOCOL", "Invalid Codex text item");
	}
	if (item.type === "userMessage") {
		if (!Array.isArray(item.content)) throw new CodexRuntimeError("PROTOCOL", "Invalid Codex user content");
		for (const value of item.content) {
			const block = object(value);
			if (block.type === "text" && typeof block.text !== "string") {
				throw new CodexRuntimeError("PROTOCOL", "Invalid Codex user text");
			}
		}
	}
}
