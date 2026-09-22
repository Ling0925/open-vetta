import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkUiSingletons } from "./check-ui-singletons.mjs";

const temporaryRoots = [];
const singletonNames = ["@radix-ui/react-focus-scope", "@radix-ui/react-dismissable-layer"];

function writePackage(directory, name, dependencies = {}) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name, version: "1.0.0", main: "index.js", dependencies }),
	);
	writeFileSync(join(directory, "index.js"), "module.exports = {};\n");
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "vetta-ui-singletons-"));
	temporaryRoots.push(root);
	writePackage(root, "fixture", { "@radix-ui/react-dialog": "1.0.0", "@radix-ui/react-menu": "1.0.0" });
	for (const consumer of ["@radix-ui/react-dialog", "@radix-ui/react-menu"]) {
		writePackage(
			join(root, "node_modules", consumer),
			consumer,
			Object.fromEntries(singletonNames.map((name) => [name, "1.0.0"])),
		);
	}
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("overlay runtime singleton contract", () => {
	it("accepts nested overlay consumers resolving the same physical stateful modules", () => {
		const root = fixture();
		for (const name of singletonNames) writePackage(join(root, "node_modules", name), name);
		expect(checkUiSingletons(root, ["package.json"])).toEqual([]);
	});

	it("rejects separate copies even when their versions are identical", () => {
		const root = fixture();
		for (const consumer of ["@radix-ui/react-dialog", "@radix-ui/react-menu"]) {
			for (const name of singletonNames)
				writePackage(join(root, "node_modules", consumer, "node_modules", name), name);
		}
		const errors = checkUiSingletons(root, ["package.json"]);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("react-focus-scope has multiple runtime instances");
		expect(errors[1]).toContain("react-dismissable-layer has multiple runtime instances");
		expect(errors.join("\n")).toContain("react-dialog/node_modules");
		expect(errors.join("\n")).toContain("react-menu/node_modules");
	});

	it("reports an incomplete install rather than treating missing modules as safe", () => {
		const root = fixture();
		const errors = checkUiSingletons(root, ["package.json"]);
		expect(errors.some((error) => error.includes("cannot resolve @radix-ui/react-focus-scope"))).toBe(true);
		expect(errors.some((error) => error.includes("run bun install first"))).toBe(true);
	});
});
