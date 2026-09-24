import type { StreamFn } from "@vetta/agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@vetta/ai";
import type { RuntimeSessionModelView } from "@vetta/runtime-core";
import { describe, expect, it, vi } from "vitest";
import {
	CodingAgentSessionAssistanceRuntime,
	cleanSuggestionList,
	resolveSessionAssistanceCandidates,
	sanitizeAutoTitle,
	sanitizeSuggestions,
} from "../src/features/session-assistance/session-assistance-runtime.js";

function createModel(provider: string, id: string): Model<Api> {
	return { api: "openai-responses", provider, id, input: ["text"] } as Model<Api>;
}

function assistantText(model: Model<Api>, text: string): AssistantMessage {
	return {
		...createAssistantMessage({ api: model.api, provider: model.provider, model: model.id }),
		content: [{ type: "text", text }],
	};
}

function assistantToolCall(
	model: Model<Api>,
	name: string,
	args: Record<string, unknown>,
	id = "call-1",
): AssistantMessage {
	return {
		...createAssistantMessage({ api: model.api, provider: model.provider, model: model.id }),
		content: [{ type: "toolCall", id, name, arguments: args }],
	};
}

function createTitleRuntime(model: Model<Api>, responses: readonly AssistantMessage[]) {
	const queue = [...responses];
	// 每个模型 ID 只在一个用例里出现：候选解析带跨调用（进程级）的失败冷却，
	// 复用同一 provider/id 会让后一个用例拿不到候选。
	const streamFn = vi.fn<StreamFn>(() => completedStream(queue.shift()));
	const runtime = new CodingAgentSessionAssistanceRuntime({
		models: createView(model, [model], async () => "test-key"),
		readSessionId: () => "conversation-title",
		streamFn,
	});
	return { runtime, streamFn };
}

describe("CodingAgentSessionAssistanceRuntime", () => {
	it("uses the injected model-call port and current conversation identity for session assistance", async () => {
		const model = createModel("session-assistance-identity", "current");
		const view = createView(model, [model], async () => "test-key");
		const responses: AssistantMessage[] = [
			assistantText(model, "会话标题"),
			assistantToolCall(model, "provide_prompt_suggestions", { suggestions: ["继续"] }),
		];
		const streamFn = vi.fn<StreamFn>(() => completedStream(responses.shift()));
		let sessionId = "conversation-42";
		const runtime = new CodingAgentSessionAssistanceRuntime({
			models: view,
			readSessionId: () => sessionId,
			streamFn,
		});

		await expect(runtime.generateTitle("你好", "")).resolves.toBe("会话标题");
		sessionId = "conversation-43";
		await expect(runtime.generateNextPrompts("用户：你好")).resolves.toEqual(["继续"]);
		expect(streamFn).toHaveBeenCalledTimes(2);
		expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ sessionId: "conversation-42" });
		expect(streamFn.mock.calls[1]?.[2]).toMatchObject({ sessionId: "conversation-43" });
	});

	it("keeps current-model priority, deduplication, available order and the three-candidate limit", async () => {
		const current = createModel("session-assistance-priority", "current");
		const second = createModel("session-assistance-priority", "second");
		const third = createModel("session-assistance-priority", "third");
		const fourth = createModel("session-assistance-priority", "fourth");
		const view = createView(current, [current, second, third, fourth], async (model) => `key:${model.id}`);

		const candidates = await resolveSessionAssistanceCandidates(view);

		expect(candidates.map((candidate) => candidate.key)).toEqual([
			"session-assistance-priority/current",
			"session-assistance-priority/second",
			"session-assistance-priority/third",
		]);
		expect(view.refreshAvailableModels).toHaveBeenCalledOnce();
		expect(view.resolveApiKey).toHaveBeenCalledTimes(3);
	});

	it("skips candidates without credentials while preserving later available candidates", async () => {
		const current = createModel("session-assistance-credentials", "current");
		const available = createModel("session-assistance-credentials", "available");
		const view = createView(current, [available], async (model) =>
			model.id === "available" ? "available-key" : undefined,
		);

		const candidates = await resolveSessionAssistanceCandidates(view);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			key: "session-assistance-credentials/available",
			apiKey: "available-key",
		});
	});

	it("prefers the structured title tool and never falls back to reasoning text", async () => {
		const model = createModel("title-tool", "model");
		const { runtime, streamFn } = createTitleRuntime(model, [
			assistantToolCall(model, "provide_session_title", { title: "Token 用量内置价格表配置" }),
			{
				...createAssistantMessage({ api: model.api, provider: model.provider, model: model.id }),
				content: [{ type: "thinking", thinking: "The user wants pricing. We need answer" }],
			},
		]);

		await expect(runtime.generateTitle("配置 Token 价格表", "")).resolves.toBe("Token 用量内置价格表配置");
		// 推理通道里的思考片段不再是标题候选，模型不给出标题时宁可等待下一个候选。
		await expect(runtime.generateTitle("配置 Token 价格表", "")).resolves.toBeNull();
		expect(streamFn).toHaveBeenCalledTimes(2);
	});

	it("resolves a short title from the structured title tool under a CJK budget that fits the truncation limit", async () => {
		const model = createModel("title-prompt", "model");
		// 16 个 CJK 字符：旧的一致上限（14）会把尾部的「优化」砍掉。
		const title = "移动端登录状态与 PDA 布局优化";
		const { runtime, streamFn } = createTitleRuntime(model, [
			assistantToolCall(model, "provide_session_title", { title }),
		]);
		await expect(runtime.generateTitle("移动端登录状态失效快，PDA 上元素太大", "")).resolves.toBe(title);

		// 覆盖真实用户路径：结构化工具、与用户消息同语言的要求、同一次会话身份。
		const call = streamFn.mock.calls[0];
		expect(call?.[1].tools?.map((tool) => tool.name)).toEqual(["provide_session_title"]);
		expect(JSON.stringify(call?.[1].systemPrompt)).toContain("same language as the user");
		expect(call?.[2]).toMatchObject({ sessionId: "conversation-title" });
		const requestedLimit = /10-(\d+) characters for CJK/.exec(JSON.stringify(call?.[1]))?.[1];
		// 提示词要求的字数是同一份上限的来源，两者不得再漂开。
		expect(Number(requestedLimit)).toBeGreaterThanOrEqual(Array.from(title).length);
	});

	it("sanitizes product title and suggestion fallbacks without leaking prose", () => {
		expect(sanitizeAutoTitle('  "修复 Runtime 架构。"  ')).toBe("修复 Runtime 架构");
		expect(sanitizeSuggestions('analysis [step 1]\n["继续重构", "补充测试"]')).toEqual(["继续重构", "补充测试"]);
		expect(cleanSuggestionList(["继续重构", "继续重构", 42, "补充测试"])).toEqual(["继续重构", "补充测试"]);
	});

	it("keeps the reasoning-channel fallback for next-prompt suggestions", async () => {
		const model = createModel("suggest-thinking", "model");
		const { runtime } = createTitleRuntime(model, [
			{
				...createAssistantMessage({ api: model.api, provider: model.provider, model: model.id }),
				content: [{ type: "thinking", thinking: '先看当前实现。\n["继续重构", "补充测试"]' }],
			},
		]);

		// 与标题不同，下一问建议仍接受推理通道里的候选项；两者共用该回退时不得互相牵连。
		await expect(runtime.generateNextPrompts("用户：重构 runtime")).resolves.toEqual(["继续重构", "补充测试"]);
	});

	it("truncates over-long titles at the same limit the title prompt asks for", () => {
		const overlongCjk = "一二三四五六七八九十一二三四五六七八九十甲乙丙";
		expect(Array.from(sanitizeAutoTitle(overlongCjk))).toHaveLength(20);
		expect(sanitizeAutoTitle("A fairly long English session title that keeps going well past the limit")).toBe(
			"A fairly long English session title that",
		);
	});
});

function completedStream(message: AssistantMessage | undefined) {
	if (!message) throw new Error("Missing recorded session-assistance response");
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function createView(
	current: Model<Api> | undefined,
	available: readonly Model<Api>[],
	resolve: (model: Model<Api>) => Promise<string | undefined>,
): RuntimeSessionModelView & {
	refreshAvailableModels: ReturnType<typeof vi.fn>;
	resolveApiKey: ReturnType<typeof vi.fn>;
} {
	return {
		readCurrentModel: () => current,
		refreshAvailableModels: vi.fn(),
		readAvailableModels: () => available,
		resolveApiKey: vi.fn(resolve),
	};
}
