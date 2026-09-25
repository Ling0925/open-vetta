import type { HistoryEntry } from "@vetta/runtime-core";
import type { CodexWorkspaceRow } from "../../shared/codex-workspace.js";

/** A bounded display window, never a replacement for the Codex-owned complete transcript. */
export function codexHistoryRows(history: readonly HistoryEntry[]) {
	const recent = history.slice(-200);
	const rows: CodexWorkspaceRow[] = [];
	let remaining = 256000;
	for (const [index, entry] of [...recent.entries()].reverse()) {
		if (remaining === 0) break;
		let kind: CodexWorkspaceRow["kind"] = "note";
		let text = "";
		let id = `marker:${history.length - recent.length + index}`;
		if (entry.type === "message") {
			id = entry.entryId ?? id;
			const message = entry.message;
			kind = message.role === "user" ? "user" : message.role === "toolResult" ? "tool" : "assistant";
			if (typeof message.content === "string") text = message.content;
			else text = message.content.flatMap(block => {
				if (block.type === "text") return [block.text];
				if (block.type === "thinking") { kind = "thinking"; return [block.thinking]; }
				if (block.type === "toolCall") { kind = "tool"; return [JSON.stringify({ name: block.name, arguments: block.arguments }, null, 2)]; }
				return [];
			}).join("\n");
		} else if (entry.type === "error") { kind = "error"; text = entry.message; id = entry.entryId ?? id; }
		else if (entry.type === "custom_marker") { text = JSON.stringify(entry.details ?? { type: entry.customType }, null, 2); }
		else continue;
		const limit = Math.min(16000, remaining); const display = text.slice(0, limit);
		rows.unshift({ id, kind, text: display, truncated: text.length > limit }); remaining -= display.length;
	}
	return { rows, hasEarlierRows: history.length > recent.length || remaining === 0 };
}
