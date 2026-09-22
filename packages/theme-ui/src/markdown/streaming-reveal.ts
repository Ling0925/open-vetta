/**
 * Split visible streaming text into stable phrase-sized spans for CSS fade-in.
 *
 * Segmentation never withholds text: the host already batches assistant deltas,
 * so every render must show the complete host snapshot. Earlier segments remain
 * stable as append-only text grows, allowing React to reuse their DOM nodes.
 */

/** 无标点长片段的切分上限（UTF-16 code units）。 */
const MAX_PHRASE_LENGTH = 48;
/** 按上限切分时，优先在这个长度之后的最后一个空白处断开。 */
const MIN_SOFT_BREAK_LENGTH = 16;

/** 淡入时长，与 `.streaming-chunk` 的 CSS 保持一致。 */
const STREAMING_FADE_MS = 400;
/** 最后一次宿主更新后，等淡入播完再撤掉分段 span。 */
export const STREAMING_SETTLE_MS = STREAMING_FADE_MS + 50;

const CJK_BREAK = new Set(["，", "。", "；", "：", "！", "？", "、", "…"]);
const CJK_TRAILING = new Set(["，", "。", "；", "：", "！", "？", "、", "…", "”", "’", "）", "」", "』", "》", "】"]);
const LATIN_BREAK = new Set([",", ".", ";", ":", "!", "?"]);
const WHITESPACE = /\s/;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function nextSegmentEnd(text: string, from: number): number {
	const length = text.length;
	for (let index = from; index < length; index++) {
		const char = text[index] as string;
		if (char === "\n") return index + 1;

		if (CJK_BREAK.has(char)) {
			let end = index + 1;
			while (end < length && CJK_TRAILING.has(text[end] as string)) end++;
			return end;
		}

		// 英文标点只有后面跟着空白才断句：`3.14`、`e.g.x`、URL 里的点都不断开。
		if (LATIN_BREAK.has(char) && index + 1 < length && WHITESPACE.test(text[index + 1] as string)) {
			return index + 1;
		}

		if (index + 1 - from >= MAX_PHRASE_LENGTH) {
			for (let back = index; back >= from + MIN_SOFT_BREAK_LENGTH; back--) {
				if (WHITESPACE.test(text[back] as string)) return back;
			}
			return isHighSurrogate(text.charCodeAt(index)) ? Math.min(length, index + 2) : index + 1;
		}
	}
	return length;
}

/** 把可见文本切成淡入短语；拼接结果恒等于输入，未完成尾部也立即包含在内。 */
export function splitStreamingSegments(value: string): string[] {
	const segments: string[] = [];
	for (let start = 0; start < value.length; ) {
		const end = nextSegmentEnd(value, start);
		segments.push(value.slice(start, end));
		start = end;
	}
	return segments;
}
