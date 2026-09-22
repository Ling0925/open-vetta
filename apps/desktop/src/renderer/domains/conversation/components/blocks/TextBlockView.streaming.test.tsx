// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { TextBlockView } from "@vetta-org/theme-ui/chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FULL_TEXT =
	"As twilight falls, the city wakes up. Streetlights flicker on, shadows stretch across the pavement, and the air turns cool.";

function renderView(text: string, isStreamingTail: boolean) {
	const props = {
		theme: "dark" as const,
		labels: { copy: "copy", copied: "copied" },
		getFileIconClass: () => "",
		onOpenFile: () => {},
		onOpenUrl: () => {},
	};
	const view = render(<TextBlockView {...props} text={text} isStreamingTail={isStreamingTail} />);
	return {
		container: view.container,
		rerender: (nextText: string, nextTail: boolean) =>
			view.rerender(<TextBlockView {...props} text={nextText} isStreamingTail={nextTail} />),
	};
}

function shownText(container: HTMLElement): string {
	return container.textContent ?? "";
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("TextBlockView streaming tail", () => {
	it("shows every host batch immediately without a second phrase reveal queue", () => {
		const initial = `${"A long streamed sentence with enough content to wrap naturally. ".repeat(160)}开始分析。`;
		const appended = `${initial}\n${"继续输出，不应在浏览器中再次排队。".repeat(80)}`;
		const { container, rerender } = renderView(initial, true);

		expect(shownText(container)).toBe(initial);
		rerender(appended, true);
		expect(shownText(container)).toBe(appended);

		act(() => vi.advanceTimersByTime(15_000));
		expect(shownText(container)).toBe(appended);
	});

	it("wraps visible phrases in fade segments while streaming", () => {
		const { container } = renderView(FULL_TEXT, true);
		const chunks = Array.from(container.querySelectorAll(".streaming-chunk"), (node) => node.textContent);

		expect(chunks.slice(0, 2)).toEqual(["As twilight falls,", " the city wakes up."]);
		expect(shownText(container)).toBe(FULL_TEXT);
	});

	it("shows an unfinished tail immediately and replaces it with the next host snapshot", () => {
		const { container, rerender } = renderView("Hello there, gene", true);
		expect(shownText(container)).toBe("Hello there, gene");

		rerender("Hello there, general Kenobi. You are", true);
		expect(shownText(container)).toBe("Hello there, general Kenobi. You are");
	});

	it("shows the complete final batch synchronously, then only settles the fade wrappers", () => {
		const { container, rerender } = renderView(FULL_TEXT, true);
		const finalText = `${FULL_TEXT} The end`;

		rerender(finalText, false);
		expect(shownText(container)).toBe(finalText);
		expect(container.querySelector(".streaming-chunk")).not.toBeNull();

		act(() => vi.advanceTimersByTime(500));
		expect(shownText(container)).toBe(finalText);
		expect(container.querySelector(".streaming-chunk")).toBeNull();
	});

	it("preserves CommonMark list, quote, and link semantics while the tail grows", () => {
		const first = "1. First item\n2. Second item\n\n> quoted line";
		const final = `${first}\n> continued\n\n[Documentation](https://example.test/docs)`;
		const { container, rerender } = renderView(first, true);
		rerender(final, true);

		const list = container.querySelector("ol");
		expect(list?.querySelectorAll(":scope > li")).toHaveLength(2);
		expect(container.querySelector("blockquote")?.textContent).toContain("quoted line");
		expect(container.querySelector("blockquote")?.textContent).toContain("continued");
		expect(container.querySelector('a[href="https://example.test/docs"]')?.textContent).toBe("Documentation");
	});

	it("renders non-streaming text immediately without fade segments", () => {
		const { container } = renderView(FULL_TEXT, false);
		expect(shownText(container)).toBe(FULL_TEXT);
		expect(container.querySelector(".streaming-chunk")).toBeNull();
	});
});
