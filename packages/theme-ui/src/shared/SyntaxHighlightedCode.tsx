import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { codeToHtml } from "shiki";

export interface SyntaxHighlightedCodeProps {
	code: string;
	lang: string;
	theme: "light" | "dark";
	/** 字号跟随所在正文的排版尺度；不传时用 12px 的紧凑默认值。 */
	fontSizeClass?: string;
	/**
	 * 流式尾块里的代码仍可能在涨。为 true 时只渲染等宽纯文本，不跑 Shiki，
	 * 也不构造包含整段代码的缓存 key。
	 */
	live?: boolean;
}

interface CachedHtml {
	readonly html: string;
	readonly bytes: number;
}

/**
 * 高亮结果缓存。消息列表跑在虚拟列表上，条目滚出视窗会被卸载、滚回来重新挂载；
 * 没有缓存时每次重挂都要重跑一遍 shiki，并且先渲染纯文本、拿到 HTML 再换——
 * 高度变两次，虚拟列表跟着重测量两次，表现为往回滚时卡顿加跳动。
 * 命中缓存时首帧就是高亮结果，只有一次布局。
 */
const HTML_CACHE = new Map<string, CachedHtml>();
const HIGHLIGHT_TASKS = new Map<string, Promise<string>>();
const MAX_CACHE_ENTRIES = 300;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const VIEWPORT_ROOT_MARGIN = "400px 0px";
let htmlCacheBytes = 0;

function deleteOldestCacheEntry(): boolean {
	const oldest = HTML_CACHE.keys().next().value;
	if (oldest === undefined) return false;
	const entry = HTML_CACHE.get(oldest);
	HTML_CACHE.delete(oldest);
	htmlCacheBytes -= entry?.bytes ?? 0;
	return true;
}

function putCache(key: string, html: string): boolean {
	const bytes = (key.length + html.length) * 2;
	if (bytes > MAX_CACHE_BYTES) return false;

	const previous = HTML_CACHE.get(key);
	if (previous) {
		HTML_CACHE.delete(key);
		htmlCacheBytes -= previous.bytes;
	}
	while (HTML_CACHE.size >= MAX_CACHE_ENTRIES || htmlCacheBytes + bytes > MAX_CACHE_BYTES) {
		if (!deleteOldestCacheEntry()) break;
	}
	HTML_CACHE.set(key, { html, bytes });
	htmlCacheBytes += bytes;
	return true;
}

function cacheKeyFor(theme: string, language: string, code: string): string {
	return `${theme.length}:${theme}${language.length}:${language}${code}`;
}

function getHighlightTask(key: string, code: string, language: string, theme: "light" | "dark"): Promise<string> {
	const pending = HIGHLIGHT_TASKS.get(key);
	if (pending) return pending;
	const task = codeToHtml(code, {
		lang: language,
		theme: theme === "dark" ? "github-dark-default" : "github-light-default",
	}).catch(() => "");
	HIGHLIGHT_TASKS.set(key, task);
	void task.then(() => {
		if (HIGHLIGHT_TASKS.get(key) === task) HIGHLIGHT_TASKS.delete(key);
	});
	return task;
}

function PlainCode({ code, fontSizeClass }: { code: string; fontSizeClass: string }): JSX.Element {
	return (
		<pre className="overflow-x-auto p-3">
			<code className={`${fontSizeClass} leading-[1.6] text-foreground`}>{code}</code>
		</pre>
	);
}

/**
 * Shiki-highlighted code block. Plain text while loading, offscreen, live, or on error.
 */
export function SyntaxHighlightedCode({
	code,
	lang,
	theme,
	fontSizeClass = "text-[12px]",
	live = false,
}: SyntaxHighlightedCodeProps): JSX.Element {
	const language = lang || "text";
	const cacheKey = live ? null : cacheKeyFor(theme, language, code);
	const cachedHtml = cacheKey === null ? undefined : HTML_CACHE.get(cacheKey)?.html;
	const [localResult, setLocalResult] = useState<{ readonly key: string; readonly html: string } | null>(null);
	const html = cachedHtml ?? (localResult?.key === cacheKey ? localResult.html : null);
	const hostRef = useRef<HTMLDivElement>(null);
	const [inView, setInView] = useState(cachedHtml !== undefined);

	useEffect(() => {
		if (cacheKey === null) return;
		if (HTML_CACHE.has(cacheKey)) {
			setInView(true);
			return;
		}
		const node = hostRef.current;
		if (!node || typeof IntersectionObserver !== "function") {
			setInView(true);
			return;
		}
		let visible = false;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				visible = true;
				setInView(true);
				observer.disconnect();
			},
			{ rootMargin: VIEWPORT_ROOT_MARGIN },
		);
		observer.observe(node);
		return () => {
			observer.disconnect();
			if (!visible) setInView(false);
		};
	}, [cacheKey]);

	useEffect(() => {
		if (cacheKey === null || !inView) return;
		const cached = HTML_CACHE.get(cacheKey)?.html;
		if (cached !== undefined) {
			setLocalResult({ key: cacheKey, html: cached });
			return;
		}
		let cancelled = false;
		void getHighlightTask(cacheKey, code, language, theme).then((result) => {
			if (cancelled) return;
			putCache(cacheKey, result);
			setLocalResult({ key: cacheKey, html: result });
		});
		return () => {
			cancelled = true;
		};
	}, [cacheKey, code, inView, language, theme]);

	const showPlain = live || html === null || html === "";
	return (
		<div ref={hostRef}>
			{showPlain ? (
				<PlainCode code={code} fontSizeClass={fontSizeClass} />
			) : (
				<div
					className={`overflow-x-auto ${fontSizeClass} leading-[1.6] [&_pre]:!bg-transparent [&_pre]:!p-3 [&_code]:!bg-transparent`}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki generates safe HTML
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			)}
		</div>
	);
}
