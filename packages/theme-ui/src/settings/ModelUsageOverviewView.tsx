import type { JSX } from "react";

function cn(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

export type ModelUsageRange = "24h" | "7d" | "30d" | "billingCycle";

export interface ModelUsageSlotBucket {
	readonly startedAt: number;
	readonly requests: number;
	readonly errors: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costTotal: number;
}

export interface ModelUsageOverviewModel {
	readonly provider: string;
	readonly model: string;
	readonly name: string;
	readonly api: string;
	readonly isDefault: boolean;
	readonly color: string;
	readonly requests: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	readonly outputSpeed: number;
	readonly cacheHitRate: number;
	readonly cacheSavings: number;
	readonly costShare: number;
	readonly peakWindow: string;
	readonly buckets: readonly ModelUsageSlotBucket[];
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly cacheReadPrice?: number;
	readonly cacheWritePrice?: number;
}

export interface ModelUsageOverviewStats {
	readonly periodCost: number;
	readonly periodCostOriginal: number;
	readonly cacheSavings: number;
	readonly vsLastPeriod?: number;
	readonly totalTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly activeModelCount: number;
	readonly requests: number;
	readonly avgTtftMs?: number;
	readonly peakOutputSpeed: number;
	readonly cacheHitRate: number;
	readonly avgCostPer1k: number;
}

export interface ModelUsageOverviewSlot {
	readonly startedAt: number;
	readonly label: string;
	readonly totalTokens: number;
	readonly totalCost: number;
	readonly requests: number;
	readonly cacheHitRate: number;
	readonly byModel: readonly { key: string; tokens: number; cost: number }[];
}

export interface ModelUsageOverviewViewProps {
	readonly range: ModelUsageRange;
	readonly onRangeChange: (range: ModelUsageRange) => void;
	readonly metric: "tokens" | "cost" | "requests";
	readonly onMetricChange: (metric: "tokens" | "cost" | "requests") => void;
	readonly stats: ModelUsageOverviewStats;
	readonly slots: readonly ModelUsageOverviewSlot[];
	readonly models: readonly ModelUsageOverviewModel[];
	readonly selectedSlotKey?: string;
	readonly onSelectSlot: (startedAt: number) => void;
	readonly onOpenPricing: () => void;
	readonly loading?: boolean;
	readonly empty: boolean;
	readonly footer: { totalCalls: number; totalTokens: string; periodNet: string };
	readonly labels: {
		readonly title: string;
		readonly description: string;
		readonly realtime: string;
		readonly utc8: string;
		readonly range: (range: ModelUsageRange) => string;
		readonly pricingLink: string;
		readonly stats: {
			readonly periodCost: string;
			readonly vsLastPeriod: (value: string) => string;
			readonly totalTokens: string;
			readonly activeModels: (count: number) => string;
			readonly requests: string;
			readonly calls: string;
			readonly cacheHitRate: string;
			readonly avgCostPerRequest: string;
			readonly perRequest: string;
			readonly originalPrice: string;
			readonly cacheSavings: string;
			readonly inputLabel: string;
			readonly outputLabel: string;
			readonly cacheReadLabel: string;
			readonly avgTtft: string;
			readonly peakTps: string;
		};
		readonly peak: {
			readonly title: (share: string, models: string) => string;
			readonly tokenMetric: string;
			readonly costMetric: string;
			readonly requestsMetric: string;
			readonly slotDetail: string;
			readonly allDayPeak: string;
			readonly slotTotal: string;
			readonly slotBill: string;
			readonly slotCacheHit: string;
			readonly hit: string;
		};
		readonly models: {
			readonly title: string;
			readonly description: string;
			readonly defaultBadge: string;
			readonly highFreqWindow: string;
			readonly requests: string;
			readonly hit: string;
			readonly cacheReadPrice: string;
			readonly readDiscount: string;
			readonly share: string;
			readonly saved: string;
			readonly footer: string;
			readonly totalCalls: string;
			readonly totalTokensLabel: string;
			readonly periodNet: string;
		};
		readonly legend: { input: string; cacheRead: string; output: string };
		readonly empty: string;
	};
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString();
}

function formatCost(n: number): string {
	return `$${n.toFixed(2)}`;
}

function formatPercent(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

const MODEL_DOT_CLASS: Record<string, string> = {
	indigo: "bg-indigo-400",
	cyan: "bg-cyan-400",
	emerald: "bg-emerald-400",
	amber: "bg-amber-400",
	pink: "bg-pink-400",
	violet: "bg-violet-400",
	slate: "bg-slate-400",
};

function modelDotClass(color: string): string {
	return MODEL_DOT_CLASS[color] ?? "bg-primary";
}

export function ModelUsageOverviewView({
	range,
	onRangeChange,
	metric,
	onMetricChange,
	stats,
	slots,
	models,
	selectedSlotKey,
	onSelectSlot,
	onOpenPricing,
	loading,
	empty,
	footer,
	labels,
}: ModelUsageOverviewViewProps): JSX.Element {
	const ranges: ModelUsageRange[] = ["24h", "7d", "30d", "billingCycle"];
	const metrics: Array<{ key: "tokens" | "cost" | "requests"; label: string }> = [
		{ key: "tokens", label: labels.peak.tokenMetric },
		{ key: "cost", label: labels.peak.costMetric },
		{ key: "requests", label: labels.peak.requestsMetric },
	];
	const maxSlotValue = Math.max(
		1,
		...slots.map((slot) => (metric === "tokens" ? slot.totalTokens : metric === "cost" ? slot.totalCost : slot.requests)),
	);
	const selectedSlot = slots.find((slot) => String(slot.startedAt) === selectedSlotKey) ?? slots.at(-1);
	const topModels = [...models].sort((left, right) => right.costTotal - left.costTotal).slice(0, 2);
	const peakTitle = labels.peak.title(
		formatPercent(selectedSlot && stats.totalTokens > 0 ? selectedSlot.totalTokens / Math.max(1, stats.totalTokens) : 0),
		topModels.map((model) => model.name).join(" 与 "),
	);
	return (
		<div className="flex flex-col gap-6">
			{/* 页头 */}
			<div className="flex flex-wrap items-start justify-between gap-4 pb-1">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h1 className="text-[20px] font-bold text-foreground">{labels.title}</h1>
						<span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-primary">
							{labels.realtime} · {labels.utc8}
						</span>
					</div>
					<p className="mt-1.5 text-[12px] text-muted-foreground">{labels.description}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
						{ranges.map((item) => (
							<button
								key={item}
								type="button"
								onClick={() => onRangeChange(item)}
								className={cn(
									"rounded-md px-2.5 py-1 text-[11px] transition-colors",
									range === item ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{labels.range(item)}
							</button>
						))}
					</div>
					<button
						type="button"
						onClick={onOpenPricing}
						className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
					>
						<span className="icon-[solar--bill-list-linear] h-3.5 w-3.5" />
						{labels.pricingLink}
					</button>
				</div>
			</div>

			{/* 顶部统计卡 */}
			<div className="grid grid-cols-2 gap-4 @min-[58rem]:grid-cols-4">
				<div className="rounded-xl border border-border/50 bg-card/40 p-4">
					<div className="flex items-center justify-between text-[11px] text-muted-foreground">
						<span>{labels.stats.periodCost}</span>
						{stats.vsLastPeriod !== undefined && (
							<span className={cn("font-medium", stats.vsLastPeriod >= 0 ? "text-emerald-400" : "text-amber-400")}>
								{labels.stats.vsLastPeriod(`${stats.vsLastPeriod >= 0 ? "-" : "+"}${Math.abs(stats.vsLastPeriod * 100).toFixed(1)}%`)}
							</span>
						)}
					</div>
					<div className="mt-1.5 text-[20px] font-bold tabular-nums text-foreground">{formatCost(stats.periodCost)}</div>
					<div className="mt-1 text-[10px] text-muted-foreground/70">
						{labels.stats.originalPrice} {formatCost(stats.periodCostOriginal)} · {labels.stats.cacheSavings}{" "}
						{formatCost(stats.cacheSavings)}
					</div>
				</div>
				<div className="rounded-xl border border-border/50 bg-card/40 p-4">
					<div className="text-[11px] text-muted-foreground">
						{labels.stats.totalTokens}（{labels.stats.activeModels(stats.activeModelCount)}）
					</div>
					<div className="mt-1.5 text-[20px] font-bold tabular-nums text-foreground">
						{formatTokens(stats.totalTokens)}
						<span className="ml-1 text-[11px] font-normal text-muted-foreground">Tokens</span>
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground/70">
						{labels.stats.inputLabel} {formatTokens(stats.inputTokens)} · {labels.stats.cacheReadLabel}{" "}
						{formatTokens(stats.cacheReadTokens)} · {labels.stats.outputLabel} {formatTokens(stats.outputTokens)}
					</div>
				</div>
				<div className="rounded-xl border border-border/50 bg-card/40 p-4">
					<div className="text-[11px] text-muted-foreground">{labels.stats.requests}</div>
					<div className="mt-1.5 text-[20px] font-bold tabular-nums text-foreground">
						{stats.requests.toLocaleString()}
						<span className="ml-1 text-[11px] font-normal text-muted-foreground">{labels.stats.calls}</span>
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground/70">
						{labels.stats.avgTtft} {stats.avgTtftMs !== undefined ? `${(stats.avgTtftMs / 1000).toFixed(2)}s` : "—"} ·{" "}
						{labels.stats.peakTps} {stats.peakOutputSpeed.toFixed(0)} tok/s
					</div>
				</div>
				<div className="rounded-xl border border-border/50 bg-card/40 p-4">
					<div className="text-[11px] text-muted-foreground">{labels.stats.cacheHitRate}</div>
					<div className="mt-1.5 text-[20px] font-bold tabular-nums text-foreground">
						{formatPercent(stats.cacheHitRate)}
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground/70">
						{labels.stats.avgCostPerRequest} ${stats.avgCostPer1k.toFixed(4)} {labels.stats.perRequest}
					</div>
				</div>
			</div>

			{empty ? (
				<div className="rounded-xl border border-dashed border-border/60 bg-card/30 px-6 py-16 text-center text-[12px] text-muted-foreground">
					{labels.empty}
				</div>
			) : (
				<>
					{/* 时段图 + 剖析 */}
					<div className="grid gap-4 @min-[72rem]:grid-cols-[minmax(0,1fr)_300px]">
						<div className="min-w-0 rounded-xl border border-border/50 bg-card/40 p-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="text-[12px] font-medium text-foreground">{peakTitle}</div>
								<div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
									{metrics.map((item) => (
										<button
											key={item.key}
											type="button"
											onClick={() => onMetricChange(item.key)}
											className={cn(
												"rounded-md px-2 py-0.5 text-[10px] transition-colors",
												metric === item.key
													? "bg-background text-foreground shadow-sm"
													: "text-muted-foreground hover:text-foreground",
											)}
										>
											{item.label}
										</button>
									))}
								</div>
							</div>
							<div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
								{models.map((model) => (
									<span key={`${model.provider}/${model.model}`} className="flex items-center gap-1">
										<span className={cn("h-1.5 w-1.5 rounded-full", modelDotClass(model.color))} />
										{model.name} {formatPercent(model.costShare)}
									</span>
								))}
							</div>
							{/* 堆叠柱状图 */}
							<div className="mt-4 flex h-40 items-end gap-1.5">
								{slots.map((slot) => {
									const height = Math.max(2, (metric === "tokens" ? slot.totalTokens : metric === "cost" ? slot.totalCost : slot.requests) / maxSlotValue * 100);
									const selected = String(slot.startedAt) === (selectedSlotKey ?? String(selectedSlot?.startedAt ?? ""));
									return (
										<button
											key={slot.startedAt}
											type="button"
											onClick={() => onSelectSlot(slot.startedAt)}
											className="group flex min-w-0 flex-1 flex-col items-center gap-1"
										>
											<div className="text-[9px] tabular-nums text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
												{metric === "tokens" ? formatTokens(slot.totalTokens) : metric === "cost" ? formatCost(slot.totalCost) : slot.requests}
											</div>
											<div
												className={cn(
													"flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-md transition-all",
													selected ? "ring-1 ring-inset ring-primary/50" : "",
												)}
												style={{ height: `${height}%` }}
											>
												{slot.byModel.map((part) => {
													const model = models.find((item) => `${item.provider}/${item.model}` === part.key);
													const share = slot.totalTokens > 0 ? part.tokens / slot.totalTokens : 0;
													return (
														<div
															key={part.key}
															className={cn("w-full", modelDotClass(model?.color ?? "slate"))}
															style={{ height: `${Math.max(0, share * 100)}%` }}
														/>
													);
												})}
											</div>
											<div className={cn("text-[9px] tabular-nums", selected ? "text-foreground" : "text-muted-foreground/60")}>
												{slot.label}
											</div>
										</button>
									);
								})}
							</div>
						</div>
						{/* 时段剖析 */}
						{selectedSlot && (
							<div className="rounded-xl border border-border/50 bg-card/40 p-4">
								<div className="flex items-center justify-between">
									<div className="text-[12px] font-medium text-foreground">{labels.peak.slotDetail}</div>
									<span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-primary">
										{labels.peak.allDayPeak}
									</span>
								</div>
								<div className="mt-2.5 text-[11px] text-muted-foreground">{labels.peak.slotTotal}</div>
								<div className="mt-0.5 flex items-baseline justify-between">
									<span className="text-[20px] font-bold tabular-nums text-foreground">{formatTokens(selectedSlot.totalTokens)}</span>
									<span className="text-[11px] text-muted-foreground">
										{formatCost(selectedSlot.totalCost)} · {selectedSlot.requests} {labels.models.requests}
									</span>
								</div>
								<div className="mt-2 flex flex-col gap-1.5">
									{selectedSlot.byModel.map((part) => {
										const model = models.find((item) => `${item.provider}/${item.model}` === part.key);
										if (!model) return null;
										return (
											<div key={part.key} className="flex items-center gap-2 text-[11px]">
												<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", modelDotClass(model.color))} />
												<span className="min-w-0 flex-1 truncate text-foreground">{model.name}</span>
												<span className="tabular-nums text-muted-foreground">{formatTokens(part.tokens)}</span>
												<span className="tabular-nums text-muted-foreground/70">{formatCost(part.cost)}</span>
											</div>
										);
									})}
								</div>
								<div className="mt-3 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
									{labels.peak.slotCacheHit}
									<span className="float-right font-medium text-emerald-400">
										{formatPercent(selectedSlot.cacheHitRate)} {labels.peak.hit}
									</span>
								</div>
							</div>
						)}
					</div>

					{/* 各模型明细表 */}
					<div className="rounded-xl border border-border/50 bg-card/40 p-4">
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<div>
								<div className="text-[12px] font-medium text-foreground">{labels.models.title}</div>
								<div className="mt-0.5 text-[10px] text-muted-foreground/70">{labels.models.description}</div>
							</div>
							<div className="flex items-center gap-3 text-[10px] text-muted-foreground">
								<span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />{labels.legend.input}</span>
								<span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />{labels.legend.cacheRead}</span>
								<span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />{labels.legend.output}</span>
							</div>
						</div>
						<div role="region" aria-label={labels.models.title} tabIndex={0} className="mt-4 overflow-x-auto focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
							<div className="flex min-w-[980px] flex-col divide-y divide-border/40">
							{models.map((model) => {
								const total = Math.max(1, model.input + model.cacheRead + model.output);
								return (
									<div key={`${model.provider}/${model.model}`} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-3 py-3">
										<div className="min-w-0">
											<div className="flex items-center gap-1.5">
												<span className={cn("h-2 w-2 shrink-0 rounded-full", modelDotClass(model.color))} />
												<span className="truncate text-[12px] font-medium text-foreground">{model.name}</span>
												{model.isDefault && (
													<span className="rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">
														{labels.models.defaultBadge}
													</span>
												)}
											</div>
											<div className="mt-0.5 truncate pl-3.5 text-[10px] text-muted-foreground/70">{model.provider}</div>
										</div>
										<div className="text-[10px] text-muted-foreground">
											<div>{model.peakWindow}</div>
											<div className="text-muted-foreground/60">{labels.models.highFreqWindow}</div>
										</div>
										<div className="min-w-0">
											<div className="flex items-baseline gap-1.5 text-[11px]">
												<span className="font-medium tabular-nums text-foreground">{formatTokens(model.totalTokens)}</span>
												<span className="tabular-nums text-muted-foreground/70">
													入 {formatTokens(model.input)} · 缓 {formatTokens(model.cacheRead)} · 出 {formatTokens(model.output)}
												</span>
											</div>
											<div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-muted/50">
												<div className="bg-indigo-400" style={{ width: `${(model.input / total) * 100}%` }} />
												<div className="bg-cyan-400" style={{ width: `${(model.cacheRead / total) * 100}%` }} />
												<div className="bg-amber-400" style={{ width: `${(model.output / total) * 100}%` }} />
											</div>
										</div>
										<div className="text-[10px] text-muted-foreground">
											<div className="tabular-nums text-foreground">
												{model.requests.toLocaleString()} {labels.models.requests} · {labels.models.hit}{" "}
												<span className="text-emerald-400">{formatPercent(model.cacheHitRate)}</span>
											</div>
											<div className="tabular-nums text-muted-foreground/70">
												TTFT — · {model.outputSpeed.toFixed(0)} tok/s
											</div>
										</div>
										<div className="text-[10px] tabular-nums text-muted-foreground">
											{model.inputPrice !== undefined && (
												<div>入 ${model.inputPrice.toFixed(2)} · 出 ${model.outputPrice?.toFixed(2)}</div>
											)}
											{model.cacheReadPrice !== undefined && (
												<div className="text-emerald-400/90">
													{labels.models.cacheReadPrice} ${model.cacheReadPrice.toFixed(2)} ({labels.models.readDiscount})
												</div>
											)}
										</div>
										<div className="text-right">
											<div className="text-[13px] font-semibold tabular-nums text-foreground">{formatCost(model.costTotal)}</div>
											<div className="text-[10px] text-muted-foreground/70">
												{labels.models.share} {formatPercent(model.costShare)} · {labels.models.saved}{" "}
												<span className="text-emerald-400">{formatCost(model.cacheSavings)}</span>
											</div>
										</div>
									</div>
								);
							})}
							</div>
						</div>
						<div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2.5 text-[10px] text-muted-foreground/70">
							<span>{labels.models.footer}</span>
							<span className="tabular-nums">
								{labels.models.totalCalls}：{footer.totalCalls.toLocaleString()} {labels.models.requests} ·{" "}
								{labels.models.totalTokensLabel}：{footer.totalTokens} · {labels.models.periodNet}：{footer.periodNet}
							</span>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
