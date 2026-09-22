import { useEffect, useRef, useState } from "react";
import type { HastElement, HastRoot, HastText } from "./nodes";
import { STREAMING_SETTLE_MS, splitStreamingSegments } from "./streaming-reveal";

const WHITESPACE_ONLY = /^\s+$/;

/** 把流式尾块的正文按短语包成 `.streaming-chunk`，新 mount 的片段由 CSS 淡入。 */
export function rehypeStreamingChunks() {
	return (tree: HastRoot): void => {
		function visit(node: HastRoot | HastElement, inCode: boolean): void {
			const newChildren: Array<(typeof node.children)[number]> = [];
			for (const child of node.children) {
				if (child.type === "text" && !inCode) {
					for (const segment of splitStreamingSegments((child as HastText).value)) {
						if (WHITESPACE_ONLY.test(segment)) {
							newChildren.push({ type: "text", value: segment } as HastText);
							continue;
						}
						newChildren.push({
							type: "element",
							tagName: "span",
							properties: { className: ["streaming-chunk"] },
							children: [{ type: "text", value: segment } as HastText],
						});
					}
				} else {
					newChildren.push(child);
					if (child.type === "element") {
						const tag = child.tagName;
						// 表格也当字面量：单元格文字拆成片段会在更新时反复触发列宽重算。
						visit(child, inCode || tag === "code" || tag === "pre" || tag === "table");
					}
				}
			}
			node.children = newChildren as typeof node.children;
		}

		visit(tree, false);
	};
}

interface StreamingDisplayState {
	displayText: string;
	animateChunks: boolean;
}

function clearTimeoutRef(ref: { current: number | null }): void {
	if (ref.current !== null) {
		window.clearTimeout(ref.current);
		ref.current = null;
	}
}

/**
 * Mirrors the host-batched text without adding a second JavaScript reveal queue.
 * CSS phrase spans stay enabled while streaming and briefly after completion so
 * the final host batch can finish fading without delaying or mutating the text.
 */
export function useStreamingDisplayText(text: string, active: boolean): StreamingDisplayState {
	const [animateChunks, setAnimateChunks] = useState(active);
	const streamedRef = useRef(active);
	const settleTimerRef = useRef<number | null>(null);

	useEffect(() => {
		clearTimeoutRef(settleTimerRef);
		if (active) {
			streamedRef.current = true;
			setAnimateChunks(true);
			return;
		}
		if (!streamedRef.current) return;
		settleTimerRef.current = window.setTimeout(() => {
			settleTimerRef.current = null;
			streamedRef.current = false;
			setAnimateChunks(false);
		}, STREAMING_SETTLE_MS);
	}, [active]);

	useEffect(
		() => () => {
			clearTimeoutRef(settleTimerRef);
		},
		[],
	);

	return { displayText: text, animateChunks };
}
