import type { ConversationUserMessageViewModel } from "@shared/conversation";
import type { ChatConversationItem } from "@shared/store/atoms";

interface PendingOptimisticUserMessage {
	message: ConversationUserMessageViewModel;
	precedingUserCount: number;
	/**
	 * 队列镜像补的气泡只有 displayText，没有规范消息才有的 attachments /
	 * promptRef 元数据；这类气泡只按文本 + 序号吸收（ADR-0060）。
	 */
	matchTextOnly?: boolean;
	/** 已经历多少次"规范历史已到达该序号却仍未确认"的对账。 */
	unresolvedReconciles?: number;
}

/**
 * 对不上账的乐观气泡最多再撑过这么多次对账。
 * 正常气泡在消息落盘后的第一次全量历史回流就会被确认；撑不过这个上限的，
 * 说明它根本不会出现在规范历史里（例如队列镜像补出的内部消息），继续留着
 * 只会每次对账都被重新追加到列表末尾，形成永久残留且位置错乱。
 */
const MAX_UNRESOLVED_RECONCILES = 3;

const pendingByRuntimeId = new Map<string, PendingOptimisticUserMessage[]>();

/**
 * Keep a user bubble until the canonical history confirms the corresponding
 * user-message ordinal. Session switching clears the active message atom, so
 * this cache bridges the short window between optimistic rendering and the
 * runtime persisting the turn-start events.
 */
export function rememberOptimisticUserMessage(
	runtimeId: string,
	message: ConversationUserMessageViewModel,
	currentMessages: readonly ChatConversationItem[],
	options?: { matchTextOnly?: boolean },
): void {
	const pending = pendingByRuntimeId.get(runtimeId) ?? [];
	pendingByRuntimeId.set(runtimeId, [
		...pending,
		{
			message,
			precedingUserCount: currentMessages.filter((item) => item.kind === "user").length,
			...(options?.matchTextOnly ? { matchTextOnly: true } : {}),
		},
	]);
}

/**
 * 气泡被撤下时（例如 queued 回执证明消息只进了 kernel 队列、尚未被消费，
 * 或重发回退截断了列表），它的待确认记录必须一起撤销。
 *
 * 记录留着而气泡不在，下一次对账会以「还没被规范历史确认」为由把气泡重新
 * 追加回列表末尾——屏幕上就是同一条用户消息又出现了一遍。
 */
export function forgetOptimisticUserMessage(runtimeId: string, messageId: string): void {
	const pending = pendingByRuntimeId.get(runtimeId);
	if (!pending?.length) return;
	const next = pending.filter((entry) => entry.message.id !== messageId);
	if (next.length === pending.length) return;
	if (next.length === 0) {
		pendingByRuntimeId.delete(runtimeId);
		return;
	}
	pendingByRuntimeId.set(runtimeId, next);
}

/**
 * 队列条目被 turn 消费时，同一条消息可能已经作为乐观气泡显示过（发送时以为空闲、
 * 实际已在跑，queued 回执随后才到）。此时就地接管那条待确认记录：沿用发送时算出的
 * 目标序号，只把消息对象换成镜像气泡。
 *
 * 否则同一条消息会留下两份序号不同的待确认记录，其中一份永远对不上账，
 * 最终以重复气泡的形式被重新追加到列表末尾。
 *
 * @returns 被接管的气泡 id，调用方需要把它从列表里移除；没有可接管记录时为 undefined。
 */
export function supersedeOptimisticUserMessageForMirror(
	runtimeId: string,
	message: ConversationUserMessageViewModel,
): string | undefined {
	const pending = pendingByRuntimeId.get(runtimeId);
	if (!pending?.length) return undefined;
	// 只接管发送路径留下的记录：镜像路径自己补的记录已被接管过，再接管会把
	// 先前那条消息的气泡一并撤掉（同文本连发两次时可见）。
	const index = pending.findIndex(
		(entry) => entry.matchTextOnly !== true && sameText(entry.message.text, message.text),
	);
	if (index < 0) return undefined;
	const superseded = pending[index];
	const next = [...pending];
	next[index] = {
		message,
		precedingUserCount: superseded.precedingUserCount,
		matchTextOnly: true,
	};
	pendingByRuntimeId.set(runtimeId, next);
	return superseded.message.id;
}

/**
 * Reconcile a freshly loaded canonical history with optimistic user bubbles.
 * Text is checked at the recorded ordinal so an identical older prompt cannot
 * accidentally acknowledge a newer pending send.
 */
export function reconcileOptimisticUserMessages(
	runtimeId: string,
	history: readonly ChatConversationItem[],
): ChatConversationItem[] {
	const pending = pendingByRuntimeId.get(runtimeId);
	if (!pending?.length) return [...history];

	const canonicalUsers = history.filter(
		(message): message is ConversationUserMessageViewModel => message.kind === "user",
	);
	const confirmedSnapshots = new Map<
		ConversationUserMessageViewModel,
		ConversationUserMessageViewModel["inputSegments"]
	>();
	const unresolved: PendingOptimisticUserMessage[] = [];
	// 同一条规范消息不能被两条待确认气泡同时认领，否则先对上的那条会把另一条挤成孤儿。
	const claimed = new Set<number>();
	for (const entry of pending) {
		const matched = findCanonicalUserIndex(canonicalUsers, claimed, entry);
		if (matched >= 0) {
			claimed.add(matched);
			const canonical = canonicalUsers[matched];
			if (!entry.matchTextOnly && entry.message.inputSegments) {
				confirmedSnapshots.set(canonical, entry.message.inputSegments);
			}
			continue;
		}
		// 规范历史还没写到这个序号：本轮消息仍在落盘途中，无条件保留。
		if (!canonicalUsers[entry.precedingUserCount]) {
			unresolved.push(entry);
			continue;
		}
		const attempts = (entry.unresolvedReconciles ?? 0) + 1;
		if (attempts > MAX_UNRESOLVED_RECONCILES) continue;
		unresolved.push({ ...entry, unresolvedReconciles: attempts });
	}

	if (unresolved.length === 0) {
		pendingByRuntimeId.delete(runtimeId);
		return applyConfirmedInputSnapshots(history, confirmedSnapshots);
	}
	pendingByRuntimeId.set(runtimeId, unresolved);

	const historyIds = new Set(history.map((message) => message.id));
	return [
		...applyConfirmedInputSnapshots(history, confirmedSnapshots),
		...unresolved.map(({ message }) => message).filter((message) => !historyIds.has(message.id)),
	];
}

/**
 * 记录下的序号只是「记这条时屏幕上有几条用户消息」，不一定等于规范历史里的下标：
 * 用户可能在历史还没加载完（只有尾部预览）时发送，也可能因队列镜像多算了一条
 * 已被撤下的气泡。因此从记录序号起向后找第一条尚未被认领的匹配消息。
 *
 * 不向前回退：更早序号上的同文本消息可能是旧的一轮，认错会让新消息被提前吸收
 * 并丢失结构化快照（见「相同文本只出现在更早序号」用例）。
 */
function findCanonicalUserIndex(
	canonicalUsers: readonly ConversationUserMessageViewModel[],
	claimed: ReadonlySet<number>,
	entry: PendingOptimisticUserMessage,
): number {
	for (let index = entry.precedingUserCount; index < canonicalUsers.length; index += 1) {
		if (claimed.has(index)) continue;
		const canonical = canonicalUsers[index];
		const matched = entry.matchTextOnly
			? sameText(canonical.text, entry.message.text)
			: sameUserMessage(canonical, entry.message);
		if (matched) return index;
	}
	return -1;
}

function applyConfirmedInputSnapshots(
	history: readonly ChatConversationItem[],
	snapshots: ReadonlyMap<ConversationUserMessageViewModel, ConversationUserMessageViewModel["inputSegments"]>,
): ChatConversationItem[] {
	if (snapshots.size === 0) return [...history];
	return history.map((message) => {
		if (message.kind !== "user") return message;
		const inputSegments = snapshots.get(message);
		return inputSegments ? { ...message, inputSegments } : message;
	});
}

export function clearOptimisticUserMessages(runtimeId?: string): void {
	if (runtimeId) {
		pendingByRuntimeId.delete(runtimeId);
		return;
	}
	pendingByRuntimeId.clear();
}

function sameUserMessage(
	canonical: ConversationUserMessageViewModel,
	optimistic: ConversationUserMessageViewModel,
): boolean {
	return (
		sameText(canonical.text, optimistic.text) &&
		canonical.settingsAssistTabId === optimistic.settingsAssistTabId &&
		samePromptRef(canonical.promptRef, optimistic.promptRef) &&
		sameAttachments(canonical.attachments, optimistic.attachments)
	);
}

function sameText(canonical: string, optimistic: string): boolean {
	return canonical === optimistic || (optimistic === "" && canonical === "(see attached content)");
}

function samePromptRef(
	a: ConversationUserMessageViewModel["promptRef"],
	b: ConversationUserMessageViewModel["promptRef"],
): boolean {
	if (!a || !b) return a === b;
	return a.kind === b.kind && a.name === b.name;
}

function sameAttachments(
	a: ConversationUserMessageViewModel["attachments"],
	b: ConversationUserMessageViewModel["attachments"],
): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return (
		left.length === right.length &&
		left.every((item, index) => item.kind === right[index]?.kind && item.path === right[index]?.path)
	);
}
