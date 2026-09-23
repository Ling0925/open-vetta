import { migrateProjectEntries, type ProjectEntry } from "../config/desktop-config-store.js";

/** 只读网页观察的项目投影：只有这两个数组的变化才需要唤醒观察者。 */
export interface ProjectProjection {
	readonly projects: readonly ProjectEntry[];
	readonly archivedProjects: readonly ProjectEntry[];
}

/** 从磁盘原文（未经白名单解析）或已解析配置里取出项目投影。 */
export function readProjectProjection(source: Record<string, unknown> | ProjectProjection): ProjectProjection {
	return {
		projects: migrateProjectEntries(source.projects),
		archivedProjects: migrateProjectEntries(source.archivedProjects),
	};
}

/**
 * 这次配置写入是否真的改变了项目投影。
 *
 * 与 `parseDesktopConfig` 用同一套归一化：旧版本写成字符串数组的 `projects` 也要按同一
 * 口径比较，否则一次无关的设置保存会被判成变化。`name` 的显式 `undefined` 与缺失等价，
 * 比较前统一剔除。
 */
export function projectProjectionChanged(previous: ProjectProjection, next: ProjectProjection): boolean {
	return !projectProjectionEquals(previous, next);
}

function projectProjectionEquals(left: ProjectProjection, right: ProjectProjection): boolean {
	return (
		JSON.stringify(serializeEntries(left.projects)) === JSON.stringify(serializeEntries(right.projects)) &&
		JSON.stringify(serializeEntries(left.archivedProjects)) ===
			JSON.stringify(serializeEntries(right.archivedProjects))
	);
}

function serializeEntries(entries: readonly ProjectEntry[]): ProjectEntry[] {
	return entries.map((entry) => (entry.name ? { path: entry.path, name: entry.name } : { path: entry.path }));
}
