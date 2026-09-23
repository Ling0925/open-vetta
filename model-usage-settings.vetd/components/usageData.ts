export interface TimeSlotPoint {
	slot: string;
	label: string;
	periodName: string;
	sonnet: number;
	gpt5: number;
	deepseek: number;
	gemini: number;
	haiku: number;
	totalTokensM: number;
	costUsd: number;
	requests: number;
	cacheHitPct: number;
}

export interface ModelUsageRecord {
	id: string;
	name: string;
	provider: string;
	apiProtocol: string;
	roleTag: string;
	isDefault?: boolean;
	capabilities: string[];
	dotClass: string;
	textClass: string;
	barClass: string;
	badgeTintClass: string;
	peakWindow: string;
	hourlySpark: number[];
	tokens: {
		inputM: number;
		cacheReadM: number;
		cacheWriteM: number;
		outputM: number;
		totalM: number;
	};
	metrics: {
		requests: number;
		cacheHitRate: string;
		ttft: string;
		tps: string;
		avgContextK: number;
	};
	pricing: {
		input: string;
		output: string;
		cacheRead: string;
		cacheWrite: string;
		cacheDiscount: string;
	};
	cost: {
		actualUsd: string;
		savedUsd: string;
		sharePct: string;
		rawUsdNum: number;
	};
}

export const TIME_SLOTS_24H: TimeSlotPoint[] = [
	{
		slot: "00:00",
		label: "00–02",
		periodName: "夜间批处理",
		sonnet: 2.1,
		gpt5: 0.8,
		deepseek: 1.9,
		gemini: 0.4,
		haiku: 0.6,
		totalTokensM: 5.8,
		costUsd: 1.18,
		requests: 142,
		cacheHitPct: 64,
	},
	{
		slot: "02:00",
		label: "02–04",
		periodName: "夜间静默",
		sonnet: 0.9,
		gpt5: 0.3,
		deepseek: 1.2,
		gemini: 0.2,
		haiku: 0.4,
		totalTokensM: 3.0,
		costUsd: 0.54,
		requests: 78,
		cacheHitPct: 61,
	},
	{
		slot: "04:00",
		label: "04–06",
		periodName: "凌晨自动化",
		sonnet: 0.7,
		gpt5: 0.2,
		deepseek: 1.4,
		gemini: 0.2,
		haiku: 0.5,
		totalTokensM: 3.0,
		costUsd: 0.49,
		requests: 84,
		cacheHitPct: 66,
	},
	{
		slot: "06:00",
		label: "06–08",
		periodName: "早间预热",
		sonnet: 2.4,
		gpt5: 1.1,
		deepseek: 1.6,
		gemini: 0.6,
		haiku: 0.9,
		totalTokensM: 6.6,
		costUsd: 1.62,
		requests: 196,
		cacheHitPct: 65,
	},
	{
		slot: "08:00",
		label: "08–10",
		periodName: "上午编码启动",
		sonnet: 7.6,
		gpt5: 3.4,
		deepseek: 2.8,
		gemini: 1.5,
		haiku: 1.7,
		totalTokensM: 17.0,
		costUsd: 4.52,
		requests: 468,
		cacheHitPct: 69,
	},
	{
		slot: "10:00",
		label: "10–12",
		periodName: "上午深度构建",
		sonnet: 12.8,
		gpt5: 5.9,
		deepseek: 4.2,
		gemini: 2.4,
		haiku: 2.5,
		totalTokensM: 27.8,
		costUsd: 7.48,
		requests: 710,
		cacheHitPct: 73,
	},
	{
		slot: "12:00",
		label: "12–14",
		periodName: "午间轻量检索",
		sonnet: 5.4,
		gpt5: 2.2,
		deepseek: 3.1,
		gemini: 1.1,
		haiku: 1.8,
		totalTokensM: 13.6,
		costUsd: 3.35,
		requests: 362,
		cacheHitPct: 67,
	},
	{
		slot: "14:00",
		label: "14–16",
		periodName: "下午重构高峰",
		sonnet: 15.2,
		gpt5: 7.4,
		deepseek: 5.3,
		gemini: 3.1,
		haiku: 2.9,
		totalTokensM: 33.9,
		costUsd: 9.18,
		requests: 892,
		cacheHitPct: 75,
	},
	{
		slot: "16:00",
		label: "16–18",
		periodName: "全天吞吐峰值",
		sonnet: 17.4,
		gpt5: 8.2,
		deepseek: 6.1,
		gemini: 3.6,
		haiku: 3.1,
		totalTokensM: 38.4,
		costUsd: 10.42,
		requests: 986,
		cacheHitPct: 77,
	},
	{
		slot: "18:00",
		label: "18–20",
		periodName: "傍晚联调审查",
		sonnet: 8.9,
		gpt5: 4.1,
		deepseek: 3.5,
		gemini: 1.8,
		haiku: 1.9,
		totalTokensM: 20.2,
		costUsd: 5.38,
		requests: 514,
		cacheHitPct: 71,
	},
	{
		slot: "20:00",
		label: "20–22",
		periodName: "晚间多代理协同",
		sonnet: 6.2,
		gpt5: 2.9,
		deepseek: 2.6,
		gemini: 1.2,
		haiku: 1.4,
		totalTokensM: 14.3,
		costUsd: 3.74,
		requests: 348,
		cacheHitPct: 68,
	},
	{
		slot: "22:00",
		label: "22–24",
		periodName: "夜间收尾回归",
		sonnet: 3.4,
		gpt5: 1.5,
		deepseek: 1.9,
		gemini: 0.7,
		haiku: 0.9,
		totalTokensM: 8.4,
		costUsd: 2.12,
		requests: 210,
		cacheHitPct: 65,
	},
];

export const MODEL_USAGE_RECORDS: ModelUsageRecord[] = [
	{
		id: "anthropic/claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		provider: "Anthropic",
		apiProtocol: "anthropic-messages",
		roleTag: "主力编码与多文件重构",
		isDefault: true,
		capabilities: ["200K ctx", "reasoning", "vision"],
		dotClass: "bg-series-1",
		textClass: "text-series-1",
		barClass: "bg-series-1",
		badgeTintClass: "bg-series-1/15 text-series-1",
		peakWindow: "14:00–18:00",
		hourlySpark: [25, 12, 10, 28, 52, 78, 42, 92, 100, 62, 46, 30],
		tokens: {
			inputM: 21.8,
			cacheReadM: 54.6,
			cacheWriteM: 3.8,
			outputM: 3.0,
			totalM: 83.2,
		},
		metrics: {
			requests: 2140,
			cacheHitRate: "76.8%",
			ttft: "0.62s",
			tps: "78 tok/s",
			avgContextK: 64,
		},
		pricing: {
			input: "$3.00",
			output: "$15.00",
			cacheRead: "$0.30",
			cacheWrite: "$3.75",
			cacheDiscount: "0.1× 读取",
		},
		cost: {
			actualUsd: "$26.48",
			savedUsd: "$19.65",
			sharePct: "52.9%",
			rawUsdNum: 26.48,
		},
	},
	{
		id: "openai/gpt-5.4",
		name: "GPT-5.4",
		provider: "OpenAI",
		apiProtocol: "openai-responses",
		roleTag: "架构审查与复杂推理",
		capabilities: ["256K ctx", "reasoning", "vision"],
		dotClass: "bg-series-2",
		textClass: "text-series-2",
		barClass: "bg-series-2",
		badgeTintClass: "bg-series-2/15 text-series-2",
		peakWindow: "15:00–18:00",
		hourlySpark: [18, 10, 8, 22, 48, 72, 35, 88, 96, 56, 40, 24],
		tokens: {
			inputM: 12.4,
			cacheReadM: 21.8,
			cacheWriteM: 1.6,
			outputM: 2.2,
			totalM: 38.0,
		},
		metrics: {
			requests: 985,
			cacheHitRate: "65.2%",
			ttft: "0.79s",
			tps: "71 tok/s",
			avgContextK: 52,
		},
		pricing: {
			input: "$2.50",
			output: "$10.00",
			cacheRead: "$0.25",
			cacheWrite: "$2.50",
			cacheDiscount: "0.1× 读取",
		},
		cost: {
			actualUsd: "$13.45",
			savedUsd: "$8.20",
			sharePct: "26.9%",
			rawUsdNum: 13.45,
		},
	},
	{
		id: "deepseek/deepseek-v3.2",
		name: "DeepSeek V3.2",
		provider: "DeepSeek",
		apiProtocol: "openai-completions",
		roleTag: "批量单测生成与守护进程",
		capabilities: ["128K ctx", "reasoning"],
		dotClass: "bg-series-3",
		textClass: "text-series-3",
		barClass: "bg-series-3",
		badgeTintClass: "bg-series-3/15 text-series-3",
		peakWindow: "14:00–19:00",
		hourlySpark: [38, 26, 28, 34, 54, 70, 58, 86, 94, 64, 50, 40],
		tokens: {
			inputM: 11.2,
			cacheReadM: 20.4,
			cacheWriteM: 1.2,
			outputM: 2.8,
			totalM: 35.6,
		},
		metrics: {
			requests: 1020,
			cacheHitRate: "66.4%",
			ttft: "0.54s",
			tps: "92 tok/s",
			avgContextK: 38,
		},
		pricing: {
			input: "$0.27",
			output: "$1.10",
			cacheRead: "$0.07",
			cacheWrite: "$0.27",
			cacheDiscount: "0.26× 读取",
		},
		cost: {
			actualUsd: "$3.86",
			savedUsd: "$2.14",
			sharePct: "7.7%",
			rawUsdNum: 3.86,
		},
	},
	{
		id: "google/gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		provider: "Google Vertex",
		apiProtocol: "google-generative-ai",
		roleTag: "全仓上下文检索与视觉走查",
		capabilities: ["1M ctx", "vision", "reasoning"],
		dotClass: "bg-series-4",
		textClass: "text-series-4",
		barClass: "bg-series-4",
		badgeTintClass: "bg-series-4/15 text-series-4",
		peakWindow: "10:00–17:00",
		hourlySpark: [14, 8, 8, 20, 44, 68, 38, 82, 90, 52, 36, 22],
		tokens: {
			inputM: 6.4,
			cacheReadM: 8.6,
			cacheWriteM: 0.6,
			outputM: 1.2,
			totalM: 16.8,
		},
		metrics: {
			requests: 395,
			cacheHitRate: "58.9%",
			ttft: "0.88s",
			tps: "64 tok/s",
			avgContextK: 118,
		},
		pricing: {
			input: "$1.25",
			output: "$10.00",
			cacheRead: "$0.31",
			cacheWrite: "$1.25",
			cacheDiscount: "0.25× 读取",
		},
		cost: {
			actualUsd: "$4.62",
			savedUsd: "$1.86",
			sharePct: "9.2%",
			rawUsdNum: 4.62,
		},
	},
	{
		id: "anthropic/claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		provider: "Anthropic",
		apiProtocol: "anthropic-messages",
		roleTag: "标题摘要、路由与探索子代理",
		capabilities: ["200K ctx", "fast"],
		dotClass: "bg-series-5",
		textClass: "text-series-5",
		barClass: "bg-series-5",
		badgeTintClass: "bg-series-5/15 text-series-5",
		peakWindow: "08:00–18:00",
		hourlySpark: [22, 16, 18, 32, 60, 82, 64, 92, 96, 68, 52, 34],
		tokens: {
			inputM: 5.2,
			cacheReadM: 11.4,
			cacheWriteM: 0.6,
			outputM: 1.4,
			totalM: 18.6,
		},
		metrics: {
			requests: 450,
			cacheHitRate: "70.4%",
			ttft: "0.31s",
			tps: "134 tok/s",
			avgContextK: 24,
		},
		pricing: {
			input: "$0.80",
			output: "$4.00",
			cacheRead: "$0.08",
			cacheWrite: "$1.00",
			cacheDiscount: "0.1× 读取",
		},
		cost: {
			actualUsd: "$1.61",
			savedUsd: "$1.35",
			sharePct: "3.3%",
			rawUsdNum: 1.61,
		},
	},
];
