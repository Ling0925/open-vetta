import { describe, expect, it } from "vitest";
import { projectProjectionChanged, readProjectProjection } from "./project-projection.js";

describe("projectProjectionChanged", () => {
	it("只把项目投影的真实变化当作变化", () => {
		const previous = readProjectProjection({
			projects: [{ path: "C:/workspace/demo", name: "demo" }],
			archivedProjects: [],
		});

		// 同一份项目、另一个无关字段被保存：不算项目变化。
		expect(
			projectProjectionChanged(previous, {
				projects: [{ path: "C:/workspace/demo", name: "demo" }],
				archivedProjects: [],
			}),
		).toBe(false);
		expect(
			projectProjectionChanged(previous, {
				projects: [{ path: "C:/workspace/demo", name: "renamed" }],
				archivedProjects: [],
			}),
		).toBe(true);
	});

	it("把旧版本写出的字符串数组按同一口径比较", () => {
		const previous = readProjectProjection({ projects: ["C:/workspace/demo"] });
		expect(
			projectProjectionChanged(previous, { projects: [{ path: "C:/workspace/demo" }], archivedProjects: [] }),
		).toBe(false);
		expect(projectProjectionChanged(previous, { projects: [], archivedProjects: [] })).toBe(true);
	});

	it("归档区变化单独算一次变化", () => {
		const previous = readProjectProjection({ projects: [] });
		expect(projectProjectionChanged(previous, { projects: [], archivedProjects: [{ path: "C:/old" }] })).toBe(true);
	});

	it("缺省 name 与显式 undefined 等价", () => {
		const previous = readProjectProjection({ projects: [{ path: "C:/workspace/demo" }] });
		expect(
			projectProjectionChanged(previous, {
				projects: [{ path: "C:/workspace/demo", name: undefined }],
				archivedProjects: [],
			}),
		).toBe(false);
	});
});
