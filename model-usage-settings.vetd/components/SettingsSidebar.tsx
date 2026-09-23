import { Link, useLocation } from "react-router";

interface SidebarNavItem {
	key: string;
	label: string;
	icon: string;
	active?: boolean;
	badge?: string;
	children?: Array<{
		to: string;
		label: string;
		icon: string;
	}>;
}

const NAV_GROUPS: Array<{ title?: string; items: SidebarNavItem[] }> = [
	{
		items: [
			{ key: "account", label: "账户", icon: "icon-[lucide--user-round]" },
			{ key: "general", label: "通用设置", icon: "icon-[lucide--settings-2]" },
			{ key: "appearance", label: "外观", icon: "icon-[lucide--palette]" },
		],
	},
	{
		title: "AI 与模型",
		items: [
			{ key: "context", label: "Agent配置", icon: "icon-[lucide--bot]" },
			{ key: "models", label: "模型配置", icon: "icon-[lucide--cpu]" },
			{
				key: "model-usage",
				label: "模型用量",
				icon: "icon-[lucide--bar-chart-3]",
				active: true,
				children: [
					{
						to: "/",
						label: "时段与指标总览",
						icon: "icon-[lucide--activity]",
					},
					{
						to: "/pricing",
						label: "价格标准与账单拆解",
						icon: "icon-[lucide--receipt-text]",
					},
				],
			},
			{ key: "knowledge", label: "知识库设置", icon: "icon-[lucide--database]" },
		],
	},
	{
		title: "连接与环境",
		items: [
			{ key: "sshHosts", label: "SSH 主机", icon: "icon-[lucide--server]" },
			{ key: "webAccess", label: "Web 访问", icon: "icon-[lucide--globe]" },
			{ key: "im", label: "Claw", icon: "icon-[lucide--message-square-code]" },
			{ key: "webhook", label: "消息推送", icon: "icon-[lucide--webhook]" },
			{ key: "shortcuts", label: "快捷键", icon: "icon-[lucide--keyboard]" },
			{ key: "environment", label: "应用环境", icon: "icon-[lucide--package]" },
		],
	},
];

export function SettingsSidebar() {
	const { pathname } = useLocation();

	return (
		<aside className="flex w-[216px] shrink-0 flex-col justify-between bg-surface-raised/75 px-3 py-4 select-none">
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between px-2.5 pt-1">
					<div className="flex items-center gap-2.5">
						<span className="flex size-7 items-center justify-center rounded-lg bg-surface-subtle text-surface-foreground">
							<span className="icon-[lucide--arrow-left] size-3.5" />
						</span>
						<span className="font-display text-[18px] font-bold tracking-tight text-surface-foreground">
							设置
						</span>
					</div>
					<span className="rounded-md bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
						⌘,
					</span>
				</div>

				<div className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-[12px] text-muted">
					<span className="icon-[lucide--search] size-3.5 shrink-0 text-subtle" />
					<span className="truncate">搜索设置或模型…</span>
				</div>

				<nav className="flex flex-col gap-4">
					{NAV_GROUPS.map((group, groupIndex) => (
						<div key={groupIndex} className="flex flex-col gap-0.5">
							{group.title && (
								<div className="px-2.5 pb-1 text-[11px] font-medium tracking-wider text-subtle uppercase">
									{group.title}
								</div>
							)}
							{group.items.map((item) => {
								const isExpanded = Boolean(item.active && item.children?.length);
								return (
									<div key={item.key} className="flex flex-col">
										{item.active ? (
											<Link
												to="/"
												className="flex items-center gap-2.5 rounded-lg bg-surface-subtle px-2.5 py-2 text-[13px] font-medium text-surface-foreground transition-colors"
											>
												<span className={`${item.icon} size-4 shrink-0 text-primary`} />
												<span className="flex-1 truncate text-left">{item.label}</span>
												<span className="icon-[lucide--chevron-down] size-3.5 shrink-0 text-muted" />
											</Link>
										) : (
											<div className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted">
												<span className={`${item.icon} size-4 shrink-0 text-subtle`} />
												<span className="flex-1 truncate text-left">{item.label}</span>
											</div>
										)}

										{isExpanded && (
											<div className="mt-1 flex flex-col gap-0.5 ps-4">
												{item.children?.map((child) => {
													const isCurrent = pathname === child.to;
													return (
														<Link
															key={child.to}
															to={child.to}
															className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
																isCurrent
																	? "bg-primary/15 font-medium text-primary"
																	: "text-muted hover:bg-surface-subtle/60 hover:text-surface-foreground"
															}`}
														>
															<span className={`${child.icon} size-3.5 shrink-0`} />
															<span className="truncate">{child.label}</span>
														</Link>
													);
												})}
											</div>
										)}
									</div>
								);
							})}
						</div>
					))}
				</nav>
			</div>

			<div className="rounded-lg bg-surface px-3 py-2.5">
				<div className="flex items-center justify-between text-[11px]">
					<span className="font-medium text-surface-foreground">本地计量账本</span>
					<span className="flex items-center gap-1 text-success">
						<span className="size-1.5 rounded-full bg-success" />
						实时记账
					</span>
				</div>
				<div className="mt-1 truncate font-mono text-[10px] text-subtle">
					~/.vetta/agent/models.json
				</div>
			</div>
		</aside>
	);
}
