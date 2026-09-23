import { readFile, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export interface WebStaticAsset {
	readonly body: Buffer;
	readonly contentType: string;
}

export interface WebStaticAssets {
	get(pathname: string): WebStaticAsset | undefined;
}

export async function loadWebStaticAssets(root: string): Promise<WebStaticAssets> {
	const rootPath = await realpath(root);
	const index = await readFile(join(rootPath, "index.html"));
	const paths = new Set(["/", "/index.html"]);
	for (const match of index.toString("utf8").matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
		const value = match[1];
		if (!value || value.startsWith("http:") || value.startsWith("https:") || value.startsWith("data:")) continue;
		const pathname = normalizeAssetPath(value, "/index.html");
		if (pathname) paths.add(pathname);
	}
	const entries = new Map<string, WebStaticAsset>();
	for (const pathname of paths) {
		const relativePath = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
		const absolutePath = await realpath(join(rootPath, relativePath));
		if (!isInside(rootPath, absolutePath)) throw new Error("Web asset escaped its build root");
		const body = await readFile(absolutePath);
		const contentType = contentTypeFor(absolutePath);
		entries.set(pathname, { body, contentType });
		if (contentType === "text/css; charset=utf-8") {
			for (const match of body.toString("utf8").matchAll(/url\((?:["']?)([^)"']+)(?:["']?)\)/g)) {
				const assetPath = normalizeAssetPath(match[1] ?? "", pathname);
				if (assetPath) paths.add(assetPath);
			}
		}
	}
	return { get: (pathname) => entries.get(pathname) };
}

function normalizeAssetPath(value: string, basePath: string): string | undefined {
	const rawPath = value.trim().split("?", 1)[0]?.split("#", 1)[0];
	if (
		!rawPath ||
		rawPath.startsWith("#") ||
		rawPath.startsWith("%23") ||
		rawPath.startsWith("data:") ||
		rawPath.startsWith("http:") ||
		rawPath.startsWith("https:")
	)
		return undefined;
	const rawSegments = rawPath.startsWith("/")
		? rawPath.split("/")
		: [...basePath.split("/").slice(0, -1), ...rawPath.split("/")];
	const segments: string[] = [];
	for (const segment of rawSegments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const pathname = `/${segments.join("/")}`;
	if (!pathname || pathname.endsWith(".map")) return undefined;
	return pathname;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`));
}

function contentTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}
