import type { ChatConversationItem } from "@shared/store/atoms";

export interface SharedChatMessageSnapshot {
	messages: ChatConversationItem[];
	reusedCount: number;
}

/**
 * Reconcile two independently mapped views of the same persisted history.
 *
 * Viewer preview and Runtime hydration intentionally use separate I/O paths, so
 * they cannot share object identity on their own.  This hydration-boundary
 * comparison preserves the preview objects for messages whose serialized
 * contract is unchanged. React.memo can then retain already-painted rows while
 * still replacing any message that Runtime canonicalization actually changed.
 *
 * ChatConversationItem is a JSON-compatible renderer DTO. Keep this comparison out of
 * render paths: it is only meant for the one-off preview -> canonical handoff.
 */
export function shareChatMessageSnapshot(
	preview: readonly ChatConversationItem[],
	canonical: readonly ChatConversationItem[],
): SharedChatMessageSnapshot {
	if (preview === canonical) {
		return { messages: preview as ChatConversationItem[], reusedCount: preview.length };
	}
	if (preview.length === 0 || canonical.length === 0) {
		return { messages: canonical as ChatConversationItem[], reusedCount: 0 };
	}

	const previewById = new Map(preview.map((message) => [message.id, message]));
	let reusedCount = 0;
	const messages = canonical.map((message) => {
		const candidate = previewById.get(message.id);
		if (candidate === undefined || JSON.stringify(candidate) !== JSON.stringify(message)) {
			return message;
		}
		reusedCount += 1;
		return candidate;
	});

	if (
		reusedCount === preview.length &&
		reusedCount === canonical.length &&
		messages.every((message, index) => message === preview[index])
	) {
		return { messages: preview as ChatConversationItem[], reusedCount };
	}
	return { messages, reusedCount };
}

type AgentMessage = Extract<ChatConversationItem, { kind: "agent" }>;
type AgentBlock = AgentMessage["blocks"][number];

function mergeRunningAssistantBlocks(
	persisted: AgentMessage["blocks"],
	live: AgentMessage["blocks"],
	restoredPreview: boolean,
): AgentMessage["blocks"] {
	const blocks = [...persisted];
	// A live draft without tool history continues the tail segment. Otherwise
	// shared tool identities anchor each segment while we walk in display order.
	let cursor = 0;
	if (!restoredPreview && !live.some((block) => block.type === "tool_call")) {
		for (const [index, block] of blocks.entries()) {
			if (block.type === "tool_call") cursor = index + 1;
		}
	}
	for (const block of live) {
		if (block.type === "tool_call") {
			const index = blocks.findIndex(
				(candidate) => candidate.type === "tool_call" && candidate.toolCallId === block.toolCallId,
			);
			if (index >= 0) {
				cursor = Math.max(cursor, index + 1);
				const existing = blocks[index] as Extract<AgentBlock, { type: "tool_call" }>;
				if (existing.status !== "pending" && block.status === "pending") continue;
				blocks[index] = { ...existing, ...block, result: block.result ?? existing.result };
				continue;
			}
		} else if (block.type === "text" || block.type === "thinking") {
			let matched = false;
			for (let index = cursor; index < blocks.length; index += 1) {
				const existing = blocks[index];
				if (existing.type === "tool_call") break;
				if (existing.type !== block.type) continue;
				const sameIdentity = block.id !== undefined && existing.id === block.id;
				if (sameIdentity || existing.text.startsWith(block.text) || block.text.startsWith(existing.text)) {
					if (!existing.text.startsWith(block.text)) {
						blocks[index] = { ...existing, text: block.text };
					}
					cursor = index + 1;
					matched = true;
					break;
				}
			}
			if (matched) continue;
		}
		blocks.push(block);
		cursor = blocks.length;
	}
	return blocks;
}

function lastUserId(messages: readonly ChatConversationItem[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.kind === "user") return message.id;
	}
	return undefined;
}

function mergeLiveAssistant(persisted: AgentMessage, live: AgentMessage): AgentMessage {
	const blocks = mergeRunningAssistantBlocks(persisted.blocks, live.blocks, persisted.id === live.id);
	return {
		...persisted,
		...live,
		entryId: persisted.entryId ?? live.entryId,
		timestamp: persisted.timestamp ?? live.timestamp,
		blocks,
		text: live.text
			? blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
			: persisted.text,
		usages: live.usages ?? persisted.usages,
	};
}

/**
 * Keeps rows and live updates accepted after a Viewer snapshot was committed
 * while replacing that persisted base with Runtime-canonical history.
 */
export function preserveMessagesAddedAfterSnapshot(
	preview: readonly ChatConversationItem[],
	canonical: readonly ChatConversationItem[],
	current: readonly ChatConversationItem[],
): ChatConversationItem[] {
	const previewById = new Map(preview.map((message) => [message.id, message]));
	const currentById = new Map(current.map((message) => [message.id, message]));
	let updatedCanonical: ChatConversationItem[] | undefined;
	for (const [index, message] of canonical.entries()) {
		const previewMessage = previewById.get(message.id);
		const liveMessage = currentById.get(message.id);
		// Restoring a running session adopts the durable preview row as the draft.
		// Its ID stays unchanged as events arrive, so it is not an added row below.
		if (
			message.kind === "agent" &&
			message.endedAt === undefined &&
			previewMessage?.kind === "agent" &&
			liveMessage?.kind === "agent" &&
			liveMessage !== previewMessage &&
			liveMessage.startedAt !== undefined
		) {
			updatedCanonical ??= [...canonical];
			updatedCanonical[index] = mergeLiveAssistant(message, liveMessage);
		}
	}
	const hydrated = updatedCanonical ?? (canonical as ChatConversationItem[]);
	const persistedIds = new Set(canonical.map((message) => message.id));
	const previewIds = new Set(preview.map((message) => message.id));
	const additions = current.filter((message) => !persistedIds.has(message.id));
	const previewUserId = lastUserId(preview);
	const canonicalUserId = lastUserId(canonical);
	const sameUserTurn =
		previewUserId !== undefined && previewUserId === canonicalUserId && canonicalUserId === lastUserId(current);
	const persistedTail = canonical.at(-1);
	const liveTail = additions[0];
	if (
		additions.length === 1 &&
		persistedTail?.kind === "agent" &&
		persistedTail.endedAt === undefined &&
		!previewIds.has(persistedTail.id) &&
		liveTail?.kind === "agent" &&
		liveTail.phase === "streaming" &&
		liveTail.entryId === undefined &&
		(sameUserTurn ||
			(preview.length === 0 &&
				lastUserId(current) === undefined &&
				persistedTail.timestamp !== undefined &&
				liveTail.startedAt !== undefined &&
				persistedTail.timestamp >= liveTail.startedAt))
	) {
		// Keep the live ID: buffered assistant events and the legacy draft pointer still address it until turn end.
		const merged = mergeLiveAssistant(persistedTail, liveTail);
		return [...hydrated.slice(0, -1), merged];
	}
	return additions.length === 0 ? hydrated : [...hydrated, ...additions];
}
