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
): AgentMessage["blocks"] {
	const blocks = [...persisted];
	for (const block of live) {
		if (block.type === "tool_call") {
			const index = blocks.findIndex(
				(candidate) => candidate.type === "tool_call" && candidate.toolCallId === block.toolCallId,
			);
			if (index >= 0) {
				const existing = blocks[index] as Extract<AgentBlock, { type: "tool_call" }>;
				if (existing.status !== "pending" && block.status === "pending") continue;
				blocks[index] = { ...existing, ...block, result: block.result ?? existing.result };
				continue;
			}
		} else if (block.type === "text" || block.type === "thinking") {
			let index = blocks.length - 1;
			while (index >= 0 && blocks[index]?.type !== block.type) index -= 1;
			const existing = blocks[index];
			if (existing?.type === block.type) {
				if (existing.text === block.text || existing.text.startsWith(block.text)) continue;
				if (block.text.startsWith(existing.text)) {
					blocks[index] = { ...existing, text: block.text };
					continue;
				}
			}
		}
		blocks.push(block);
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

/**
 * Keeps renderer-only rows accepted after a Viewer snapshot was committed while
 * replacing that persisted base with Runtime-canonical history.
 */
export function preserveMessagesAddedAfterSnapshot(
	preview: readonly ChatConversationItem[],
	canonical: readonly ChatConversationItem[],
	current: readonly ChatConversationItem[],
): ChatConversationItem[] {
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
		const blocks = mergeRunningAssistantBlocks(persistedTail.blocks, liveTail.blocks);
		// Keep the live ID: buffered assistant events and the legacy draft pointer still address it until turn end.
		const merged: AgentMessage = {
			...persistedTail,
			...liveTail,
			entryId: persistedTail.entryId,
			timestamp: persistedTail.timestamp ?? liveTail.timestamp,
			blocks,
			text: liveTail.text
				? blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
				: persistedTail.text,
			usages: liveTail.usages ?? persistedTail.usages,
		};
		return [...canonical.slice(0, -1), merged];
	}
	return additions.length === 0 ? (canonical as ChatConversationItem[]) : [...canonical, ...additions];
}
