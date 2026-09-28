export interface BoundedTextPreview {
	readonly text: string;
	readonly truncated: boolean;
	readonly originalChars: number;
	readonly omittedChars: number;
}

/** Live command snapshots only need enough head/tail context for the UI. */
export const CODEX_LIVE_TOOL_OUTPUT_CHARS = 16 * 1024;
/** Canonical history keeps a larger preview but never the unbounded command output. */
export const CODEX_PERSISTED_TOOL_OUTPUT_CHARS = 64 * 1024;
/** Leave margin below the Codex host's 1,048,576-character input ceiling. */
export const CODEX_HANDOFF_SAFE_CHARS = 900_000;
/** Existing stdio transport guard; independent from the host character ceiling. */
export const CODEX_HANDOFF_TRANSPORT_BYTES = 3 * 1024 * 1024;

export function boundedTextPreview(text: string, maxChars: number): BoundedTextPreview {
	const limit = Math.max(0, Math.floor(maxChars));
	if (text.length <= limit) {
		return { text, truncated: false, originalChars: text.length, omittedChars: 0 };
	}
	if (limit === 0) {
		return { text: "", truncated: true, originalChars: text.length, omittedChars: text.length };
	}
	const marker = `\n\n[Vetta truncated output: ${text.length} characters total; showing head and tail]\n\n`;
	if (marker.length >= limit) {
		return {
			text: marker.slice(0, limit),
			truncated: true,
			originalChars: text.length,
			omittedChars: text.length,
		};
	}
	const available = limit - marker.length;
	const headChars = Math.ceil(available / 2);
	const tailChars = Math.floor(available / 2);
	return {
		text: text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(-tailChars) : ""),
		truncated: true,
		originalChars: text.length,
		omittedChars: text.length - headChars - tailChars,
	};
}
