import { describe, expect, test } from "vitest";
import { splitStreamingSegments } from "./streaming-reveal";

describe("splitStreamingSegments", () => {
	test("round-trips mixed Latin and CJK source text", () => {
		const text = "Hello, world! 你好世界，这是流式输出。\n  indented 3.14 and more";
		expect(splitStreamingSegments(text).join("")).toBe(text);
	});

	test("splits Latin text into stable phrases with leading whitespace attached", () => {
		expect(splitStreamingSegments("As twilight falls, the city wakes. Lights flicker")).toEqual([
			"As twilight falls,",
			" the city wakes.",
			" Lights flicker",
		]);
	});

	test("keeps earlier CJK segments stable as append-only text grows", () => {
		const before = splitStreamingSegments("秋天来了，天气凉了，");
		const after = splitStreamingSegments("秋天来了，天气凉了，树叶黄了。");
		expect(after.slice(0, before.length)).toEqual(before);
	});

	test("keeps an unfinished tail in the visual segment partition", () => {
		expect(splitStreamingSegments("Hello there, gene")).toEqual(["Hello there,", " gene"]);
	});

	test("keeps CJK closing punctuation attached to its phrase", () => {
		expect(splitStreamingSegments("他说：“秋天到了。”然后走了")).toEqual(["他说：", "“秋天到了。”", "然后走了"]);
	});

	test("caps long unpunctuated runs without splitting a surrogate pair", () => {
		const latin = "word ".repeat(30);
		const segments = splitStreamingSegments(latin);
		expect(segments[0]?.length).toBeLessThanOrEqual(48);
		expect(segments.join("")).toBe(latin);

		const cjkWithEmoji = `${"秋".repeat(47)}😀tail`;
		expect(splitStreamingSegments(cjkWithEmoji)[0]).toBe(`${"秋".repeat(47)}😀`);
	});
});
