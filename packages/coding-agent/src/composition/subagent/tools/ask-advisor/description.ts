export const ASK_ADVISOR_TOOL_DESCRIPTION = [
	"Ask one read-only advisor subagent for an independent second opinion before making a consequential decision.",
	"The advisor receives the current parent context, may inspect local evidence with read-only tools, and returns a recommendation in this tool call.",
	"Use it for architecture choices, risk review, debugging hypotheses, or when a second perspective can materially improve the answer.",
	"Do not use it for routine tasks the root can answer directly. The advisor never edits files or executes mutating commands.",
	"If the consultation exceeds the timeout it continues in the background and may report later; do not spawn a duplicate advisor for the same question.",
].join("\n");
