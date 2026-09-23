import { setDesktopConfigWriteObserver } from "../config/desktop-config-store.js";
import { ProjectChangeHub } from "./project-change-hub.js";
import { projectProjectionChanged, readProjectProjection } from "./project-projection.js";

/**
 * 建立一个挂在配置写入边界上的项目变化信号。
 *
 * 项目写入分散在项目服务、项目导入、批量任务注册/回填和通用配置保存多处，逐个调用点补
 * 通知总会漏掉下一个。观察点因此放在唯一的配置文件写入边界上：只要这次写入真的改变了
 * 项目投影就推进一次游标，写入失败或内容没变则不通知。
 *
 * 判定用写入前的磁盘原文与本次写入值，口径与 `parseDesktopConfig` 一致；不比较整个配置，
 * 避免改语言、改代理也把只读网页的观察流唤醒。
 */
export function createProjectChangeHub(): ProjectChangeHub {
	const hub = new ProjectChangeHub();
	setDesktopConfigWriteObserver(({ previous, next }) => {
		if (!projectProjectionChanged(readProjectProjection(previous), next)) return;
		hub.notify();
	});
	return hub;
}
