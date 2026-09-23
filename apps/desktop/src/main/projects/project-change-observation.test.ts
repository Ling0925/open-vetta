import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VETTA_HOME_ENV } from "@vetta/action-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];
let previousHome: string | undefined;

/**
 * `desktop-config.json` 的路径在模块加载时算好，所以每个用例重置模块并重设 VETTA_HOME。
 * 这里直接跑真实的 `writeDesktopConfig`，观察点是否挂在真正的落盘边界上才算被验证到。
 */
async function loadStoreWithConfig(config: Record<string, unknown> | undefined): Promise<
	typeof import("../config/desktop-config-store.js") & {
		overwriteDisk: (config: Record<string, unknown>) => Promise<void>;
	}
> {
	const home = await mkdtemp(join(tmpdir(), "vetta-project-observation-"));
	temporaryRoots.push(home);
	process.env[VETTA_HOME_ENV] = home;
	if (config) await writeFile(join(home, "desktop-config.json"), JSON.stringify(config), "utf8");
	vi.resetModules();
	const store = await import("../config/desktop-config-store.js");
	const overwriteDisk = (next: Record<string, unknown>) =>
		writeFile(join(home, "desktop-config.json"), JSON.stringify(next), "utf8");
	return { ...store, overwriteDisk };
}

beforeEach(() => {
	previousHome = process.env[VETTA_HOME_ENV];
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env[VETTA_HOME_ENV];
	else process.env[VETTA_HOME_ENV] = previousHome;
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("项目变化信号挂在配置落盘边界上", () => {
	it("任何写入路径改到项目列表都会推进一次游标", async () => {
		const store = await loadStoreWithConfig({ projects: [] });
		const { createProjectChangeHub } = await import("./project-change-observation.js");
		const hub = createProjectChangeHub();
		const cursor = hub.getCursor();

		// 走通用配置保存，而不是项目服务：这正是首轮审计漏掉的通知路径。
		await store.writeDesktopConfig({
			...(await store.readDesktopConfig()),
			projects: [{ path: "C:/workspace/imported", name: "imported" }],
		});

		expect(hub.getCursor()).toBe(cursor + 1);
	});

	it("与项目无关的配置保存不会唤醒观察者", async () => {
		const store = await loadStoreWithConfig({ projects: [{ path: "C:/workspace/demo", name: "demo" }] });
		const { createProjectChangeHub } = await import("./project-change-observation.js");
		const hub = createProjectChangeHub();
		const cursor = hub.getCursor();

		await store.writeDesktopConfig({ ...(await store.readDesktopConfig()), debugMode: true });
		expect(hub.getCursor()).toBe(cursor);
	});

	it("没有真正改变项目投影的写入不通知，归档区变化通知一次", async () => {
		const store = await loadStoreWithConfig({ projects: [{ path: "C:/workspace/demo", name: "demo" }] });
		const { createProjectChangeHub } = await import("./project-change-observation.js");
		const hub = createProjectChangeHub();

		const config = await store.readDesktopConfig();
		await store.writeDesktopConfig({ ...config, projects: [{ path: "C:/workspace/demo", name: "demo" }] });
		expect(hub.getCursor()).toBe(0);

		await store.writeDesktopConfig({ ...config, projects: [], archivedProjects: [{ path: "C:/workspace/demo" }] });
		expect(hub.getCursor()).toBe(1);
	});
});
