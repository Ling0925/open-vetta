import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebStaticAssets } from "./static-assets.js";

describe("loadWebStaticAssets", () => {
	it("serves only the explicit index and referenced assets", async () => {
		const root = await mkdtemp(join(tmpdir(), "vetta-web-assets-"));
		try {
			await writeFile(join(root, "index.html"), '<script src="./assets/web.js"></script>');
			await writeFile(join(root, "assets-web-placeholder"), "ignored");
			await mkdir(join(root, "assets"));
			await writeFile(join(root, "assets", "web.js"), "console.log('ok')");
			await writeFile(join(root, "secret.txt"), "not public");
			const assets = await loadWebStaticAssets(root);

			expect(assets.get("/")?.contentType).toBe("text/html; charset=utf-8");
			expect(assets.get("/assets/web.js")?.contentType).toBe("text/javascript; charset=utf-8");
			expect(assets.get("/secret.txt")).toBeUndefined();
			expect(assets.get("/../secret.txt")).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it("resolves CSS urls relative to the stylesheet and keeps unrelated files private", async () => {
	const root = await mkdtemp(join(tmpdir(), "vetta-web-css-assets-"));
	try {
		await mkdir(join(root, "assets", "styles"), { recursive: true });
		await writeFile(join(root, "index.html"), '<link rel="stylesheet" href="./assets/styles/main.css">');
		await writeFile(join(root, "assets", "styles", "main.css"), 'body { background: url("../../cursor.svg"); }');
		await writeFile(join(root, "cursor.svg"), "<svg></svg>");
		await writeFile(join(root, "private.svg"), "<svg>private</svg>");
		const assets = await loadWebStaticAssets(root);
		expect(assets.get("/assets/styles/main.css")?.contentType).toBe("text/css; charset=utf-8");
		expect(assets.get("/cursor.svg")?.contentType).toBe("image/svg+xml");
		expect(assets.get("/private.svg")).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
