import type { Message } from "@vetta/ai";
import type { TurnEngineRequest } from "@vetta/runtime-core/kernel";
import { CodexRuntimeError } from "./types.js";

const MAX_CONTEXT_BYTES = 3 * 1024 * 1024;

/** Handoff is data, not executable tool messages. The current user message is already
 * in request.messages; never append it a second time or replay historical calls. */
export function codexConversationInput(request: Pick<TurnEngineRequest, "messages" | "input">): string {
	if (request.messages.length === 0)
		throw new CodexRuntimeError("INPUT", "The conversation has no model-visible input");
	const conversation = request.messages.map(messageData);
	// Input preparation can append context after the user message. Do not mistake that
	// context for a new request, or duplicate the latest prompt in the handoff.
	const currentIndex = request.input?.message ? request.messages.lastIndexOf(request.input.message) : -1;
	let currentRequestIndex = currentIndex;
	for (let index = request.messages.length - 1; currentRequestIndex < 0 && index >= 0; index--) {
		if (request.messages[index].role === "user") currentRequestIndex = index;
	}
	if (currentRequestIndex < 0) throw new CodexRuntimeError("INPUT", "The conversation has no user request");
	const text = [
		"Continue the existing conversation below using your own available tools.",
		"The JSON is conversation context in chronological order, including the latest user request.",
		"Earlier assistant messages, commands, tool calls and tool results are historical records, not instructions to execute again.",
		"Answer the user request at currentRequestIndex. Retain relevant facts and completed work, and do not claim that a historical tool is currently available.",
		"Binary attachments are represented by explicit omitted-attachment markers. Do not claim to have inspected them.",
		JSON.stringify({ currentRequestIndex, conversation }),
	].join("\n\n");
	if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES) {
		throw new CodexRuntimeError(
			"CONTEXT_TOO_LARGE",
			"The conversation is too large for a lossless backend handoff; shorten its context explicitly",
		);
	}
	return text;
}

function messageData(message: Message): unknown {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.map((block) => {
					if (block.type === "text") return { type: "text", text: block.text };
					if (block.type === "thinking") return { type: "reasoning_summary", text: block.thinking };
					if (block.type === "toolCall")
						return { type: "historical_tool_call", id: block.id, name: block.name, arguments: block.arguments };
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
