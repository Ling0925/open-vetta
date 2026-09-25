import { useCallback, useEffect, useState } from "react";
import { waitForCommittedPaint } from "@shared/lib/committed-paint";
import type { CodexModelChoice, CodexWorkspaceCommand, CodexWorkspaceReply } from "../../../shared/codex-workspace";

export function useCodexModelChoices(run: (command: CodexWorkspaceCommand) => Promise<CodexWorkspaceReply>, enabled: boolean) {
	const [models, setModels] = useState<CodexModelChoice[]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
	const [revision, setRevision] = useState(0);
	const reload = useCallback(() => setRevision(value => value + 1), []);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setStatus("loading");
		void (async () => {
			await waitForCommittedPaint();
			if (cancelled) return;
			const reply = await run({ type: "models" });
			if (cancelled) return;
			if (reply.ok && reply.models) { setModels(reply.models); setStatus("ready"); }
			else setStatus("failed");
		})().catch(() => { if (!cancelled) setStatus("failed"); });
		return () => { cancelled = true; };
	}, [enabled, revision, run]);
	return { models, status, reload };
}
