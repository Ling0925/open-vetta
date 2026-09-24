import { createConversationAgentMessage, createConversationUserMessage } from "@shared/conversation";
import type { ChatConversationItem } from "@shared/store/atoms";
import { describe, expect, it } from "vitest";
import { preserveMessagesAddedAfterSnapshot, shareChatMessageSnapshot } from "./chat-message-snapshot";

function message(id: string, text: string): ChatConversationItem {
	return createConversationAgentMessage({ id, text, blocks: [{ id: `${id}-text`, type: "text", text }] });
}

describe("shareChatMessageSnapshot", () => {
	it("完整等价时保留预览数组与所有消息引用", () => {
		const preview = [message("a", "first"), message("b", "second")];
		const canonical = [message("a", "first"), message("b", "second")];

		const result = shareChatMessageSnapshot(preview, canonical);

		expect(result.messages).toBe(preview);
		expect(result.reusedCount).toBe(2);
	});

	it("只替换 Runtime 中真正变化的消息", () => {
		const preview = [message("a", "first"), message("b", "preview")];
		const canonical = [message("a", "first"), message("b", "canonical"), message("c", "new")];

		const result = shareChatMessageSnapshot(preview, canonical);

		expect(result.messages).not.toBe(preview);
		expect(result.messages[0]).toBe(preview[0]);
		expect(result.messages[1]).toBe(canonical[1]);
		expect(result.messages[2]).toBe(canonical[2]);
		expect(result.reusedCount).toBe(1);
	});

	it("顺序改变时按稳定消息 id 复用，而不错误沿用旧位置", () => {
		const first = message("a", "first");
		const second = message("b", "second");

		const result = shareChatMessageSnapshot([first, second], [message("b", "second"), message("a", "first")]);

		expect(result.messages).toEqual([second, first]);
		expect(result.reusedCount).toBe(2);
	});

	it("Runtime 水合替换预览基线时保留其后接受的乐观消息", () => {
		const preview = [message("a", "preview")];
		const canonical = [message("a", "canonical")];
		const optimistic = createConversationUserMessage({ id: "user-pending", text: "accepted" });

		const result = preserveMessagesAddedAfterSnapshot(preview, canonical, [...preview, optimistic]);

		expect(result).toEqual([...canonical, optimistic]);
	});

	it("延迟回填时不重复追加已被 canonical 对账吸收的消息", () => {
		const queued = createConversationUserMessage({ id: "queued-user", text: "next" });

		const result = preserveMessagesAddedAfterSnapshot([], [queued], [queued]);

		expect(result).toEqual([queued]);
	});

	describe("运行中会话的历史回填", () => {
		const user = createConversationUserMessage({ id: "user-1", text: "inspect" });
		const persisted = createConversationAgentMessage({
			id: "assistant-1",
			entryId: "assistant-1",
			text: "",
			blocks: [{ type: "tool_call", toolCallId: "tool-1", toolName: "read_file", args: {}, status: "success" }],
		});
		const draft = createConversationAgentMessage({
			id: "draft-1",
			phase: "streaming",
			startedAt: 1000,
			timestamp: 1000,
			text: "",
			blocks: [],
		});

		it("将预览之后落盘的助手过程认领到仍在运行的草稿，而不显示两个气泡", () => {
			const result = preserveMessagesAddedAfterSnapshot([user], [user, persisted], [user, draft]);
			expect(result).toHaveLength(2);
			expect(result[1]).toMatchObject({
				id: draft.id,
				entryId: persisted.entryId,
				phase: "streaming",
				startedAt: draft.startedAt,
				blocks: persisted.blocks,
			});
		});

		it("保留回填期间收到的实时工具内容，并按工具标识去重", () => {
			const live = {
				...draft,
				blocks: [
					{
						type: "tool_call" as const,
						toolCallId: "tool-1",
						toolName: "read_file",
						args: {},
						status: "pending" as const,
					},
					{
						type: "tool_call" as const,
						toolCallId: "tool-2",
						toolName: "grep",
						args: {},
						status: "pending" as const,
					},
				],
			};
			const result = preserveMessagesAddedAfterSnapshot([user], [user, persisted], [user, live]);
			expect(result).toHaveLength(2);
			expect(result[1]).toMatchObject({
				id: draft.id,
				blocks: [
					expect.objectContaining({ toolCallId: "tool-1", status: "success" }),
					expect.objectContaining({ toolCallId: "tool-2", status: "pending" }),
				],
			});
		});

		it("预览读取失败时只合并当前回合落盘的助手消息", () => {
			const currentTurn = { ...persisted, timestamp: 1001 };
			const result = preserveMessagesAddedAfterSnapshot([], [user, currentTurn], [draft]);
			expect(result).toHaveLength(2);
			expect(result[1]).toMatchObject({ id: draft.id, entryId: persisted.entryId, phase: "streaming" });

			const earlierTurn = { ...persisted, timestamp: 999 };
			expect(preserveMessagesAddedAfterSnapshot([], [user, earlierTurn], [draft])).toEqual([
				user,
				earlierTurn,
				draft,
			]);
		});

		it("完整历史暂时落后于预览时保留已经显示的过程", () => {
			const previewAssistant = createConversationAgentMessage({ id: "preview-only", text: "working", blocks: [] });
			const preview = [user, previewAssistant];
			expect(preserveMessagesAddedAfterSnapshot(preview, [user], preview)).toEqual(preview);
		});

		it("新用户消息启动的草稿不能并入上一轮历史回复", () => {
			const nextUser = createConversationUserMessage({ id: "user-2", text: "follow up" });
			const result = preserveMessagesAddedAfterSnapshot([user], [user, persisted], [user, nextUser, draft]);
			expect(result).toEqual([user, persisted, nextUser, draft]);
		});
	});
});
