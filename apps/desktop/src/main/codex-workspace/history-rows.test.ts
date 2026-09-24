import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { HistoryEntry } from "@vetta/runtime-core";
import { codexHistoryRows } from "./history-rows.js";
function message(id: string, text: string): HistoryEntry { return { type: "message", entryId: id, message: { role: "user", content: text, timestamp: 1 } }; }
describe("Codex display history limits", () => {
	it("retains stable IDs and treats markup as plain text", () => {
		const rows = codexHistoryRows([message("stable", "<script>not executable</script>")]);
		assert.equal(rows.rows[0].id, "stable"); assert.equal(rows.rows[0].text, "<script>not executable</script>");
	});
	it("bounds total snapshot text while retaining the latest records", () => {
		const view = codexHistoryRows(Array.from({ length: 201 }, (_, index) => message(String(index), "x".repeat(20000))));
		assert.ok(view.rows.reduce((count, row) => count + row.text.length, 0) <= 256000);
		assert.equal(view.rows.at(-1)?.id, "200"); assert.equal(view.hasEarlierRows, true); assert.equal(view.rows.at(-1)?.truncated, true);
	});
	it("does not mutate the authoritative history while building its display window", () => {
		const history = [message("one", "original")]; const view = codexHistoryRows(history); view.rows[0].text = "changed";
		assert.equal(history[0].type === "message" && history[0].message.content, "original");
	});
});
