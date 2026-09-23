export const frame = { width: 1440, height: 900, title: "模型用量 · 价格标准与账单拆解" };

import { Link } from "react-router";
import { MODEL_USAGE_RECORDS, TIME_SLOTS_24H } from "../components/usageData";

const HEATMAP_OPACITY: Record<number, string> = {
	1: "bg-primary/15 text-muted",
	2: "bg-primary/30 text-surface-foreground",
	3: "bg-primary/50 text-surface-foreground",
	4: "bg-primary/75 text-primary-foreground font-semibold",
};

function getHeatLevel(val: number): number {
	if (val >= 75) return 4;
	if (val >= 45) return 3;
	if (val >= 25) return 2;
	return 1;
}

export default function ModelPricingLedgerFrame() {
	return (
		<div className="flex flex-col gap-5">
			{/* Page Header */}
			<header className="flex items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-2.5">
						<Link
							to="/"
							className="flex items-center gap-1 rounded-md bg-surface-raised px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-surface-foreground"
						>
							<span className="icon-[lucide--arrow-left] size-3" />
							<span>总览</span>
						</Link>
						<h1 className="font-display text-[22px] font-bold tracking-tight text-surface-foreground">
							价格标准与时段账单拆解
						</h1>
					</div>
					<p className="mt-1 text-[12px] text-muted">
						基于 ~/.vetta/agent/models.json 的四维费率（输入 / 输出 / 缓存读 / 缓存写）核算各时段成本与缓存节省
					</p>
				</div>

				<div className="flex items-center gap-2.5">
					<button
						type="button"
						className="flex items-center gap-1.5 rounded-lg bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-surface-foreground transition-colors hover:bg-surface-subtle"
					>
						<span className="icon-[lucide--refresh-cw] size-3.5 text-primary" />
						<span>同步服务商官方牌价</span>
					</button>
					<button
						type="button"
						className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground"
					>
						<span className="icon-[lucide--download] size-3.5" />
						<span>导出 CSV 对账单</span>
					</button>
				</div>
			</header>

			{/* Top Row: 24h × Model Cost Matrix + Cache Savings & Budget Breakdown */}
			<section className="grid grid-cols-12 gap-5">
				{/* Left 8 cols: 24h × 5 Models Cost & Activity Heatmap Matrix */}
				<div className="col-span-8 flex flex-col justify-between rounded-xl bg-surface-raised p-5">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-[14px] font-semibold text-surface-foreground">
								全天 12 时段 × 模型费用热力矩阵 (USD)
							</h2>
							<p className="mt-0.5 text-[11px] text-muted">
								下午 14:00–18:00 产生全天 39.2% 账单（$19.60），夜间批处理切换至 DeepSeek V3.2 显著压降成本
							</p>
						</div>
						<div className="flex items-center gap-2 text-[10px] text-muted">
							<span>低负载</span>
							<span className="size-2.5 rounded-xs bg-primary/15" />
							<span className="size-2.5 rounded-xs bg-primary/30" />
							<span className="size-2.5 rounded-xs bg-primary/50" />
							<span className="size-2.5 rounded-xs bg-primary/75" />
							<span>峰值成本</span>
						</div>
					</div>

					<div className="mt-4 flex flex-col gap-2">
						{MODEL_USAGE_RECORDS.map((model) => (
							<div key={model.id} className="flex items-center gap-3">
								<div className="flex w-36 shrink-0 items-center gap-2">
									<span className={`size-2 shrink-0 rounded-full ${model.dotClass}`} />
									<span className="truncate text-[12px] font-medium text-surface-foreground">
										{model.name}
									</span>
								</div>

								<div className="grid flex-1 grid-cols-12 gap-1.5">
									{model.hourlySpark.map((pct, slotIdx) => {
										const level = getHeatLevel(pct);
										const slotUsd = ((model.cost.rawUsdNum * pct) / 620).toFixed(2);
										return (
											<div
												key={slotIdx}
												className={`flex h-8 items-center justify-center rounded-[5px] font-mono text-[10px] tabular-nums ${HEATMAP_OPACITY[level]}`}
											>
												${slotUsd}
											</div>
										);
									})}
								</div>

								<div className="w-16 shrink-0 text-right font-mono text-[12px] font-semibold tabular-nums text-surface-foreground">
									{model.cost.actualUsd}
								</div>
							</div>
						))}

						{/* Time axis row */}
						<div className="mt-1 flex items-center gap-3 pt-1 text-[10px] text-muted">
							<div className="w-36 shrink-0 font-medium text-subtle">时段合计 (UTC+8)</div>
							<div className="grid flex-1 grid-cols-12 gap-1.5 text-center font-mono tabular-nums">
								{TIME_SLOTS_24H.map((slot) => (
									<div key={slot.slot} className="flex flex-col">
										<span className="text-surface-foreground">${slot.costUsd.toFixed(1)}</span>
										<span className="text-[9px] text-subtle">{slot.label}</span>
									</div>
								))}
							</div>
							<div className="w-16 shrink-0 text-right font-mono text-[12px] font-bold text-primary">
								$50.02
							</div>
						</div>
					</div>
				</div>

				{/* Right 4 cols: Prompt Cache Cost-Saving & Four-Dimension Cost Funnel */}
				<div className="col-span-4 flex flex-col justify-between rounded-xl bg-surface-raised p-5">
					<div>
						<div className="flex items-center justify-between">
							<h2 className="text-[14px] font-semibold text-surface-foreground">
								四维计费构成与缓存抵扣
							</h2>
							<span className="rounded bg-success/15 px-2 py-0.5 font-mono text-[11px] font-medium text-success">
								省 39.8%
							</span>
						</div>

						<div className="mt-3 flex flex-col gap-2.5">
							<div className="rounded-lg bg-surface p-3">
								<div className="flex items-center justify-between text-[11px]">
									<span className="text-muted">常规输入 (Input · 57.0M)</span>
									<span className="font-mono font-semibold text-surface-foreground">$16.84</span>
								</div>
								<div className="mt-1.5 flex items-center justify-between text-[11px]">
									<span className="text-accent">缓存读取 (Cache Read · 116.8M)</span>
									<div className="font-mono">
										<span className="mr-1.5 text-subtle line-through">$42.12</span>
										<span className="font-semibold text-success">$8.92</span>
									</div>
								</div>
								<div className="mt-1.5 flex items-center justify-between text-[11px]">
									<span className="text-muted">缓存写入 (Cache Write · 7.8M)</span>
									<span className="font-mono font-semibold text-surface-foreground">$2.38</span>
								</div>
								<div className="mt-1.5 flex items-center justify-between text-[11px]">
									<span className="text-warning">模型输出 (Output · 10.6M)</span>
									<span className="font-mono font-semibold text-surface-foreground">$21.88</span>
								</div>
							</div>
						</div>
					</div>

					<div className="mt-3 rounded-lg bg-surface p-3">
						<div className="flex items-center justify-between text-[11px]">
							<span className="font-medium text-surface-foreground">月度预算阈值预警</span>
							<span className="font-mono text-muted">$50.02 / $150.00 (33.3%)</span>
						</div>
						<div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-subtle">
							<div className="h-full w-1/3 rounded-full bg-primary" />
						</div>
						<div className="mt-1.5 flex items-center justify-between text-[10px] text-muted">
							<span>按当前日均流速预计月末支出 $118.40</span>
							<span className="text-success">预算安全</span>
						</div>
					</div>
				</div>
			</section>

			{/* Bottom Section: Four-Dimension Model Rate Sheet (matching modelPriceDraft.ts) */}
			<section className="flex flex-col">
				<div className="mb-2.5 flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						<h2 className="text-[14px] font-semibold text-surface-foreground">
							模型四维计费单价目录 (USD / 1M Tokens)
						</h2>
						<span className="text-[11px] text-muted">
							与模型配置页 cost.input / output / cacheRead / cacheWrite 字段双向同步
						</span>
					</div>
					<span className="font-mono text-[11px] text-muted">
						未配置单价的模型默认按官方 API 标准费率估算
					</span>
				</div>

				<div className="overflow-hidden rounded-xl bg-surface-raised">
					<table className="w-full border-collapse text-left">
						<thead>
							<tr className="border-b border-border text-[11px] font-medium text-muted">
								<th className="py-2.5 ps-5 pe-3">模型标识 (provider / modelId)</th>
								<th className="px-3 py-2.5">接口协议</th>
								<th className="px-3 py-2.5 text-right">输入单价 (input)</th>
								<th className="px-3 py-2.5 text-right">缓存读取 (cacheRead)</th>
								<th className="px-3 py-2.5 text-right">缓存写入 (cacheWrite)</th>
								<th className="px-3 py-2.5 text-right">输出单价 (output)</th>
								<th className="px-3 py-2.5 text-right">单次请求均价</th>
								<th className="py-2.5 ps-3 pe-5 text-right">费率状态</th>
							</tr>
						</thead>
						<tbody>
							{MODEL_USAGE_RECORDS.map((model, index) => {
								const avgPerCall = (model.cost.rawUsdNum / model.metrics.requests).toFixed(4);
								const isLast = index === MODEL_USAGE_RECORDS.length - 1;
								return (
									<tr key={model.id} className={isLast ? "" : "border-b border-border/60"}>
										<td className="py-3 ps-5 pe-3">
											<div className="flex items-center gap-2.5">
												<span className={`size-2.5 shrink-0 rounded-full ${model.dotClass}`} />
												<div>
													<div className="text-[13px] font-semibold text-surface-foreground">
														{model.name}
													</div>
													<div className="font-mono text-[11px] text-muted">{model.id}</div>
												</div>
											</div>
										</td>
										<td className="px-3 py-3">
											<span className="rounded bg-surface px-2 py-0.5 font-mono text-[11px] text-muted">
												{model.apiProtocol}
											</span>
										</td>
										<td className="px-3 py-3 text-right font-mono text-[12px] font-medium tabular-nums text-surface-foreground">
											{model.pricing.input}{" "}
											<span className="text-[10px] font-normal text-subtle">/ 1M</span>
										</td>
										<td className="px-3 py-3 text-right font-mono text-[12px] tabular-nums">
											<span className="font-semibold text-success">{model.pricing.cacheRead}</span>{" "}
											<span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
												{model.pricing.cacheDiscount}
											</span>
										</td>
										<td className="px-3 py-3 text-right font-mono text-[12px] tabular-nums text-surface-foreground">
											{model.pricing.cacheWrite}{" "}
											<span className="text-[10px] font-normal text-subtle">/ 1M</span>
										</td>
										<td className="px-3 py-3 text-right font-mono text-[12px] font-medium tabular-nums text-warning">
											{model.pricing.output}{" "}
											<span className="text-[10px] font-normal text-subtle">/ 1M</span>
										</td>
										<td className="px-3 py-3 text-right font-mono text-[12px] tabular-nums text-surface-foreground">
											${avgPerCall}{" "}
											<span className="text-[10px] text-subtle">/ 次</span>
										</td>
										<td className="py-3 ps-3 pe-5 text-right">
											<span className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-[11px] font-medium text-surface-foreground">
												<span className="icon-[lucide--sliders-horizontal] size-3 text-primary" />
												<span>已同步单价</span>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<div className="flex items-center justify-between border-t border-border/60 bg-surface/50 px-5 py-3 text-[11px] text-muted">
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--file-json] size-3.5 text-primary" />
							<span>
								配置文件路径：<strong className="font-mono font-normal text-surface-foreground">~/.vetta/agent/models.json</strong>
							</span>
							<span>·</span>
							<span>修改自定义 Provider 单价后将自动重算当前账期历史快照</span>
						</div>
						<div className="flex items-center gap-4 font-mono tabular-nums">
							<span>
								已配置费率模型：<strong className="text-surface-foreground">5 / 5</strong>
							</span>
							<span>
								平均缓存折扣率：<strong className="text-success">0.12× 标准输入价</strong>
							</span>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}
