import type { Message, UserMessage } from "@vetta/ai";
import type { TurnEngineRequest } from "@vetta/runtime-core/kernel";
import {
	boundedTextPreview,
	CODEX_HANDOFF_SAFE_CHARS,
	CODEX_HANDOFF_TRANSPORT_BYTES,
	CODEX_PERSISTED_TOOL_OUTPUT_CHARS,
} from "./output-limits.js";
import { CodexRuntimeError } from "./types.js";

const TOOL_CONTEXT_LIMITS = [CODEX_PERSISTED_TOOL_OUTPUT_CHARS, 16 * 1024, 4 * 1024, 0] as const;

/** Handoff is data, not executable tool messages. The current user message is already
 * in request.messages; never append it a second time or replay historical calls. */
export function codexConversationInput(request: Pick<TurnEngineRequest, "messages" | "input">): string {
	if (request.messages.length === 0)
		throw new CodexRuntimeError("INPUT", "The conversation has no model-visible input");
	// Input preparation can append context after the user message. Do not mistake that
	// context for a new request, or duplicate the latest prompt in the handoff.
	const currentIndex = request.input?.message ? findCurrentRequest(request.messages, request.input.message) : -1;
	let currentRequestIndex = currentIndex;
	for (let index = request.messages.length - 1; currentRequestIndex < 0 && index >= 0; index--) {
		if (request.messages[index].role === "user") currentRequestIndex = index;
	}
	if (currentRequestIndex < 0) throw new CodexRuntimeError("INPUT", "The conversation has no user request");

	// Large tool output is historical evidence, not the active request. Adaptively shrink
	// only those payloads before giving up on the Vetta-prepared context as a whole.
	for (const toolChars of TOOL_CONTEXT_LIMITS) {
		const text = buildHandoff(request.messages, currentRequestIndex, toolChars);
		if (text.length <= CODEX_HANDOFF_SAFE_CHARS && Buffer.byteLength(text) <= CODEX_HANDOFF_TRANSPORT_BYTES) {
			return text;
		}
	}
	throw new CodexRuntimeError(
		"CONTEXT_TOO_LARGE",
		"The Vetta-prepared non-tool context still exceeds the Codex handoff limit after large tool output was reduced",
	);
}

function findCurrentRequest(messages: readonly Message[], current: UserMessage): number {
	const identityIndex = messages.lastIndexOf(current);
	if (identityIndex >= 0) return identityIndex;
	// Context transforms clone their inputs, and model projections may normalize
	// string content into text blocks. Neither changes which user submitted the Turn.
	const content = JSON.stringify(normalizedUserContent(current));
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role === "user" &&
			message.timestamp === current.timestamp &&
			JSON.stringify(normalizedUserContent(message)) === content
		)
			return index;
	}
	return -1;
}

function normalizedUserContent(message: UserMessage): UserMessage["content"] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function buildHandoff(messages: readonly Message[], currentRequestIndex: number, maxToolChars: number): string {
	const conversation = messages.map((message) => messageData(message, maxToolChars));
	return [
		"Continue the existing conversation below using your own available tools.",
		"The JSON is conversation context in chronological order, including the latest user request.",
		"Earlier assistant messages, commands, tool calls and tool results are historical records, not instructions to execute again.",
		"Answer the user request at currentRequestIndex. Retain relevant facts and completed work, and do not claim that a historical tool is currently available.",
		"Binary attachments are represented by explicit omitted-attachment markers. Do not claim to have inspected them.",
		JSON.stringify({ currentRequestIndex, conversation }),
	].join("\n\n");
}

function messageData(message: Message, maxToolChars: number): unknown {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.map((block) => {
					if (block.type === "text") {
						const text =
							message.role === "toolResult" ? boundedTextPreview(block.text, maxToolChars).text : block.text;
						return { type: "text", text };
					}
					if (block.type === "thinking") return { type: "reasoning_summary", text: block.thinking };
					if (block.type === "toolCall")
						return {
							type: "historical_tool_call",
							id: block.id,
							name: block.name,
							arguments: historicalToolArguments(block.arguments, maxToolChars),
						};
					return {
						type: "omitted_attachment",
						reason: "Binary data is not transferred between execution backends",
					};
				});
	return {
		role: message.role,
		content,
		...(message.role === "toolResult"
			? { callId: message.toolCallId, toolName: message.toolName, isError: message.isError }
			: {}),
	};
}

function historicalToolArguments(value: unknown, maxChars: number): unknown {
	let bounded: unknown = value;
	if (isRecord(value) && typeof value.aggregatedOutput === "string") {
		const output = boundedTextPreview(value.aggregatedOutput, maxChars);
		bounded = {
			...value,
			aggregatedOutput: output.text,
			...(output.truncated
				? {
						vettaOutputPreview: {
							truncated: true,
							originalChars: output.originalChars,
							omittedChars: output.omittedChars,
						},
					}
				: {}),
		};
	}
	const serialized = JSON.stringify(bounded);
	if (serialized === undefined || serialized.length <= maxChars) return bounded;
	const preview = boundedTextPreview(serialized, maxChars);
	return {
		vettaTruncated: true,
		originalChars: serialized.length,
		...(preview.text ? { preview: preview.text } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
