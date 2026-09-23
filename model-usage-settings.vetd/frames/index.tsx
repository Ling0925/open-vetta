export const frame = { width: 1440, height: 900, title: "模型用量 · 时段与指标总览" };

import { useState } from "react";
import { Link } from "react-router";
import { MODEL_USAGE_RECORDS, TIME_SLOTS_24H } from "../components/usageData";

type RangeKey = "24h" | "7d" | "30d" | "cycle";
type ChartMetricKey = "tokens" | "cost" | "requests";

const RANGES: Array<{ key: RangeKey; label: string }> = [
	{ key: "24h", label: "今日 24h" },
	{ key: "7d", label: "近 7 天" },
	{ key: "30d", label: "近 30 天" },
	{ key: "cycle", label: "本计费周期" },
];

export default function ModelUsageOverviewFrame() {
	const [range, setRange] = useState<RangeKey>("24h");
	const [chartMetric, setChartMetric] = useState<ChartMetricKey>("tokens");
	const [selectedSlotIndex, setSelectedSlotIndex] = useState<number>(8); // 16:00–18:00 peak

	const activeSlot = TIME_SLOTS_24H[selectedSlotIndex] ?? TIME_SLOTS_24H[8];
	const maxSlotTokens = 40;

	return (
		<div className="flex flex-col gap-5">
			{/* Page Header */}
			<header className="flex items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-2.5">
						<h1 className="font-display text-[22px] font-bold tracking-tight text-surface-foreground">
							模型用量与计费洞察
						</h1>
						<span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary">
							实时统计 · UTC+8
						</span>
					</div>
					<p className="mt-1 text-[12px] text-muted">
						按时段追踪各模型的 Token 消耗结构、响应延迟、Prompt 缓存命中率及对应官方单价账单
					</p>
				</div>

				<div className="flex items-center gap-2.5">
					<div className="flex items-center rounded-lg bg-surface-raised p-1">
						{RANGES.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={() => setRange(item.key)}
								className={`rounded-md px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors ${
									range === item.key
										? "bg-surface-subtle text-surface-foreground"
										: "text-muted hover:text-surface-foreground"
								}`}
							>
								{item.label}
							</button>
						))}
					</div>

					<Link
						to="/pricing"
						className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-primary-foreground transition-opacity hover:opacity-90"
					>
						<span className="icon-[lucide--receipt-text] size-3.5" />
						<span>价格标准与账单拆解</span>
					</Link>
				</div>
			</header>

			{/* Lead Metric + Inline Secondary Indicators (Single Tonal Band, No Boxed KPI Grid) */}
			<section className="flex items-center justify-between gap-8 rounded-xl bg-surface-raised px-6 py-4">
				<div className="flex items-baseline gap-4">
					<div>
						<div className="flex items-center gap-2 text-[12px] font-medium text-muted">
							<span>当前周期累计估算支出</span>
							<span className="rounded bg-success/15 px-1.5 py-0.5 font-mono text-[11px] text-success">
								较上周期均值 -14.2%
							</span>
						</div>
						<div className="mt-1 flex items-baseline gap-2.5">
							<span className="font-display text-[30px] font-bold tracking-tight tabular-nums text-surface-foreground">
								$50.02
							</span>
							<span className="font-mono text-[12px] text-muted">
								原价 $83.22 · 缓存已抵扣 <strong className="font-semibold text-success">$33.20</strong>
							</span>
						</div>
					</div>
				</div>

				<div className="flex items-center gap-9">
					<div>
						<div className="text-[11px] text-muted">总消耗 Token (5 个活跃模型)</div>
						<div className="mt-0.5 flex items-baseline gap-1.5">
							<span className="font-mono text-[19px] font-semibold tabular-nums text-surface-foreground">
								192.2M
							</span>
							<span className="text-[11px] text-subtle">tokens</span>
						</div>
						<div className="mt-0.5 font-mono text-[11px] text-muted">
							输入 57.0M · 缓存读 116.8M · 输出 10.6M
						</div>
					</div>

					<div>
						<div className="text-[11px] text-muted">总请求吞吐与响应速度</div>
						<div className="mt-0.5 flex items-baseline gap-1.5">
							<span className="font-mono text-[19px] font-semibold tabular-nums text-surface-foreground">
								4,990
							</span>
							<span className="text-[11px] text-subtle">次调用</span>
						</div>
						<div className="mt-0.5 font-mono text-[11px] text-muted">
							均值 TTFT 0.64s · 峰值 84 tok/s
						</div>
					</div>

					<div>
						<div className="text-[11px] text-muted">Prompt 缓存综合命中率</div>
						<div className="mt-0.5 flex items-baseline gap-1.5">
							<span className="font-mono text-[19px] font-semibold tabular-nums text-accent">
								67.4%
							</span>
							<span className="text-[11px] text-subtle">综合折算 0.60×</span>
						</div>
						<div className="mt-0.5 font-mono text-[11px] text-muted">
							千次对话折合均价 $0.0100 / 次
						</div>
					</div>
				</div>
			</section>

			{/* Multi-Model Time-Slot Distribution Chart + Selected Slot Inspector */}
			<section className="grid grid-cols-12 gap-5 rounded-xl bg-surface-raised p-5">
				{/* Left 8 cols: Stacked Time-Slot Bar Chart */}
				<div className="col-span-8 flex flex-col justify-between">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="text-[14px] font-semibold text-surface-foreground">
								14:00–18:00 编码高峰占全天 61% 用量，Claude Sonnet 4.5 与 GPT-5.4 承担主力负载
							</h2>
							<div className="mt-1.5 flex flex-wrap items-center gap-4 text-[11px] text-muted">
								{MODEL_USAGE_RECORDS.map((m) => (
									<div key={m.id} className="flex items-center gap-1.5">
										<span className={`size-2 rounded-full ${m.dotClass}`} />
										<span className="text-surface-foreground">{m.name}</span>
										<span className="font-mono text-subtle">{m.cost.sharePct}</span>
									</div>
								))}
							</div>
						</div>

						<div className="flex items-center rounded-lg bg-surface p-0.5 text-[11px]">
							<button
								type="button"
								onClick={() => setChartMetric("tokens")}
								className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap ${
									chartMetric === "tokens"
										? "bg-surface-subtle text-surface-foreground"
										: "text-muted"
								}`}
							>
								Token 量 (M)
							</button>
							<button
								type="button"
								onClick={() => setChartMetric("cost")}
								className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap ${
									chartMetric === "cost"
										? "bg-surface-subtle text-surface-foreground"
										: "text-muted"
								}`}
							>
								时段费用 ($)
							</button>
							<button
								type="button"
								onClick={() => setChartMetric("requests")}
								className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap ${
									chartMetric === "requests"
										? "bg-surface-subtle text-surface-foreground"
										: "text-muted"
								}`}
							>
								请求次数
							</button>
						</div>
					</div>

					{/* 12 Time-Slot Columns (00:00 - 24:00) */}
					<div className="mt-4 flex h-[178px] items-end gap-2.5 pt-5">
						{TIME_SLOTS_24H.map((point, idx) => {
							const isSelected = idx === selectedSlotIndex;
							const sonnetH = Math.max(3, Math.round((point.sonnet / maxSlotTokens) * 126));
							const gpt5H = Math.max(2, Math.round((point.gpt5 / maxSlotTokens) * 126));
							const deepseekH = Math.max(2, Math.round((point.deepseek / maxSlotTokens) * 126));
							const geminiH = Math.max(2, Math.round((point.gemini / maxSlotTokens) * 126));
							const haikuH = Math.max(2, Math.round((point.haiku / maxSlotTokens) * 126));

							const topValueLabel =
								chartMetric === "tokens"
									? `${point.totalTokensM.toFixed(1)}M`
									: chartMetric === "cost"
										? `$${point.costUsd.toFixed(2)}`
										: `${point.requests}`;

							return (
								<button
									key={point.slot}
									type="button"
									onClick={() => setSelectedSlotIndex(idx)}
									className={`group flex flex-1 flex-col items-center gap-1.5 rounded-lg px-1 pt-1.5 pb-1 transition-colors ${
										isSelected
											? "bg-surface-subtle/85 ring-1 ring-primary/50"
											: "hover:bg-surface-subtle/40"
									}`}
								>
									<span
										className={`font-mono text-[10px] tabular-nums ${
											isSelected
												? "font-semibold text-primary"
												: "text-subtle group-hover:text-surface-foreground"
										}`}
									>
										{topValueLabel}
									</span>

									<div className="flex w-full flex-col-reverse overflow-hidden rounded-[4px] bg-surface/60">
										<div style={{ height: `${sonnetH}px` }} className="w-full bg-series-1" />
										<div style={{ height: `${gpt5H}px` }} className="w-full bg-series-2" />
										<div style={{ height: `${deepseekH}px` }} className="w-full bg-series-3" />
										<div style={{ height: `${geminiH}px` }} className="w-full bg-series-4" />
										<div style={{ height: `${haikuH}px` }} className="w-full bg-series-5" />
									</div>

									<span
										className={`font-mono text-[10px] whitespace-nowrap ${
											isSelected ? "font-semibold text-surface-foreground" : "text-muted"
										}`}
									>
										{point.label}
									</span>
								</button>
							);
						})}
					</div>
				</div>

				{/* Right 4 cols: Selected Time-Slot Breakdown Inspector */}
				<div className="col-span-4 flex flex-col justify-between rounded-lg bg-surface p-4">
					<div>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<span className="icon-[lucide--clock-3] size-3.5 text-primary" />
								<span className="font-mono text-[12px] font-semibold text-surface-foreground">
									{activeSlot.label}:00 时段剖析
								</span>
							</div>
							<span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
								{activeSlot.periodName}
							</span>
						</div>

						<div className="mt-3 flex items-baseline justify-between">
							<div>
								<div className="text-[11px] text-muted">该时段总消耗</div>
								<div className="font-display text-[22px] font-bold tabular-nums text-surface-foreground">
									{activeSlot.totalTokensM.toFixed(1)}M{" "}
									<span className="font-sans text-[11px] font-normal text-muted">Tokens</span>
								</div>
							</div>
							<div className="text-right">
								<div className="text-[11px] text-muted">时段账单 / 请求</div>
								<div className="font-mono text-[14px] font-semibold tabular-nums text-surface-foreground">
									${activeSlot.costUsd.toFixed(2)}{" "}
									<span className="text-[11px] font-normal text-muted">· {activeSlot.requests} 次</span>
								</div>
							</div>
						</div>

						<div className="mt-3 flex flex-col gap-2">
							{[
								{
									name: "Claude Sonnet 4.5",
									val: activeSlot.sonnet,
									cost: (activeSlot.sonnet * 0.31).toFixed(2),
									dot: "bg-series-1",
								},
								{
									name: "GPT-5.4",
									val: activeSlot.gpt5,
									cost: (activeSlot.gpt5 * 0.35).toFixed(2),
									dot: "bg-series-2",
								},
								{
									name: "DeepSeek V3.2",
									val: activeSlot.deepseek,
									cost: (activeSlot.deepseek * 0.11).toFixed(2),
									dot: "bg-series-3",
								},
								{
									name: "Gemini 2.5 Pro",
									val: activeSlot.gemini,
									cost: (activeSlot.gemini * 0.27).toFixed(2),
									dot: "bg-series-4",
								},
								{
									name: "Claude Haiku 4.5",
									val: activeSlot.haiku,
									cost: (activeSlot.haiku * 0.09).toFixed(2),
									dot: "bg-series-5",
								},
							].map((row) => (
								<div key={row.name} className="flex items-center justify-between text-[11px]">
									<div className="flex items-center gap-2">
										<span className={`size-2 rounded-full ${row.dot}`} />
										<span className="text-surface-foreground">{row.name}</span>
									</div>
									<div className="font-mono tabular-nums text-muted">
										<span className="text-surface-foreground">{row.val.toFixed(1)}M</span> · ${row.cost}
									</div>
								</div>
							))}
						</div>
					</div>

					<div className="mt-3 flex items-center justify-between pt-2 text-[11px] text-muted">
						<span>时段缓存命中率</span>
						<span className="font-mono font-semibold text-success">{activeSlot.cacheHitPct}% 命中</span>
					</div>
				</div>
			</section>

			{/* Scan-Critical Model Metrics & Pricing Table */}
			<section className="flex flex-col">
				<div className="mb-2.5 flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						<h2 className="text-[14px] font-semibold text-surface-foreground">
							各模型用量指标与单价明细
						</h2>
						<span className="text-[11px] text-muted">
							单价取自 ~/.vetta/agent/models.json · 单位 USD / 1M Tokens
						</span>
					</div>
					<div className="flex items-center gap-4 text-[11px] text-muted">
						<span className="flex items-center gap-1.5">
							<span className="size-2 rounded-xs bg-primary" />
							常规输入
						</span>
						<span className="flex items-center gap-1.5">
							<span className="size-2 rounded-xs bg-accent" />
							缓存读取 (Cache Read)
						</span>
						<span className="flex items-center gap-1.5">
							<span className="size-2 rounded-xs bg-warning" />
							模型输出
						</span>
					</div>
				</div>

				<div className="overflow-hidden rounded-xl bg-surface-raised">
					<table className="w-full border-collapse text-left">
						<thead>
							<tr className="border-b border-border text-[11px] font-medium text-muted">
								<th className="py-2.5 ps-5 pe-3">模型与职责</th>
								<th className="px-3 py-2.5">24h 活跃峰值时段</th>
								<th className="px-3 py-2.5">Token 用量构成 (输入 / 缓存读 / 输出)</th>
								<th className="px-3 py-2.5 text-right">调用与性能指标</th>
								<th className="px-3 py-2.5 text-right">官方单价 ($ / 1M)</th>
								<th className="py-2.5 ps-3 pe-5 text-right">累计费用与占比</th>
							</tr>
						</thead>
						<tbody>
							{MODEL_USAGE_RECORDS.map((model, index) => {
								const inputPct = Math.round((model.tokens.inputM / model.tokens.totalM) * 100);
								const cachePct = Math.round((model.tokens.cacheReadM / model.tokens.totalM) * 100);
								const outputPct = Math.max(4, 100 - inputPct - cachePct);
								const isLast = index === MODEL_USAGE_RECORDS.length - 1;

								return (
									<tr
										key={model.id}
										className={isLast ? "" : "border-b border-border/60"}
									>
										{/* Column 1: Model & Provider */}
										<td className="py-3 ps-5 pe-3">
											<div className="flex items-center gap-2.5">
												<span className={`size-2.5 shrink-0 rounded-full ${model.dotClass}`} />
												<div>
													<div className="flex items-center gap-2">
														<span className="text-[13px] font-semibold text-surface-foreground">
															{model.name}
														</span>
														{model.isDefault && (
															<span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
																默认
															</span>
														)}
														<span className="text-[11px] text-subtle">{model.provider}</span>
													</div>
													<div className="mt-0.5 text-[11px] text-muted">{model.roleTag}</div>
												</div>
											</div>
										</td>

										{/* Column 2: 24h Sparkline & Peak Window */}
										<td className="px-3 py-3">
											<div className="flex items-center gap-2.5">
												<div className="flex h-6 w-24 items-end gap-[2px]">
													{model.hourlySpark.map((pct, i) => (
														<div
															key={i}
															style={{ height: `${Math.max(15, pct)}%` }}
															className={`flex-1 rounded-[1px] ${
																pct >= 80 ? model.barClass : "bg-surface-subtle"
															}`}
														/>
													))}
												</div>
												<div className="font-mono text-[11px] tabular-nums text-muted">
													<div>{model.peakWindow}</div>
													<div className="text-[10px] text-subtle">高频窗口</div>
												</div>
											</div>
										</td>

										{/* Column 3: Token Breakdown Bar */}
										<td className="px-3 py-3">
											<div className="w-52">
												<div className="flex items-baseline justify-between font-mono text-[11px] tabular-nums">
													<span className="font-semibold text-surface-foreground">
														{model.tokens.totalM.toFixed(1)}M
													</span>
													<span className="text-[10px] text-muted">
														入 {model.tokens.inputM}M · 缓 {model.tokens.cacheReadM}M · 出{" "}
														{model.tokens.outputM}M
													</span>
												</div>
												<div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-surface">
													<div style={{ width: `${inputPct}%` }} className="bg-primary" />
													<div style={{ width: `${cachePct}%` }} className="bg-accent" />
													<div style={{ width: `${outputPct}%` }} className="bg-warning" />
												</div>
											</div>
										</td>

										{/* Column 4: Performance Metrics */}
										<td className="px-3 py-3 text-right font-mono text-[11px] tabular-nums">
											<div className="text-surface-foreground">
												{model.metrics.requests.toLocaleString()} 次 ·{" "}
												<span className="text-accent">命中 {model.metrics.cacheHitRate}</span>
											</div>
											<div className="mt-0.5 text-[10px] text-muted">
												TTFT {model.metrics.ttft} · {model.metrics.tps}
											</div>
										</td>

										{/* Column 5: Pricing Rates ($ / 1M) */}
										<td className="px-3 py-3 text-right font-mono text-[11px] tabular-nums">
											<div className="text-surface-foreground">
												入 {model.pricing.input} · 出 {model.pricing.output}
											</div>
											<div className="mt-0.5 text-[10px] text-success">
												缓存读 {model.pricing.cacheRead} ({model.pricing.cacheDiscount})
											</div>
										</td>

										{/* Column 6: Total Cost & Share */}
										<td className="py-3 ps-3 pe-5 text-right font-mono tabular-nums">
											<div className="text-[13px] font-semibold text-surface-foreground">
												{model.cost.actualUsd}
											</div>
											<div className="mt-0.5 text-[10px] text-muted">
												占比 {model.cost.sharePct} ·{" "}
												<span className="text-success">省 {model.cost.savedUsd}</span>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<div className="flex items-center justify-between border-t border-border/60 bg-surface/50 px-5 py-2.5 text-[11px] text-muted">
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--check-circle-2] size-3.5 text-success" />
							<span>所有调用均已根据响应 Usage 元数据完成本地记账，支持按小时与计费周期回溯</span>
						</div>
						<div className="flex items-center gap-5 font-mono tabular-nums">
							<span>
								合计调用：<strong className="text-surface-foreground">4,990 次</strong>
							</span>
							<span>
								合计 Token：<strong className="text-surface-foreground">192.2M</strong>
							</span>
							<span>
								本期净支出：<strong className="text-primary">$50.02</strong>
							</span>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}
