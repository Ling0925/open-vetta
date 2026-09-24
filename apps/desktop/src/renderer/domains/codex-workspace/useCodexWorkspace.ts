import { useCallback, useEffect, useRef, useState } from "react";
import { waitForCommittedPaint } from "@shared/lib/committed-paint";
import type { CodexWorkspaceCommand, CodexWorkspaceReply } from "../../../shared/codex-workspace";
import { CodexWorkspaceClient, type CodexWorkspaceClientState } from "./workspace-client";

export function useCodexWorkspace(attempt: number) {
	const current = useRef<CodexWorkspaceClient | undefined>(undefined);
	const [state, setState] = useState<CodexWorkspaceClientState>({ connection: "loading", pending: [] });
	useEffect(() => {
		const client = new CodexWorkspaceClient(window.vetta.codexWorkspace, waitForCommittedPaint,
			callback => { window.setTimeout(callback, 100); });
		current.current = client; setState(client.read());
		const unsubscribe = client.subscribe(() => setState(client.read()));
		void client.start();
		return () => { unsubscribe(); client.dispose(); if (current.current === client) current.current = undefined; };
	}, [attempt]);
	const run = useCallback((command: CodexWorkspaceCommand): Promise<CodexWorkspaceReply> =>
		current.current?.run(command) ?? Promise.resolve({ ok: false, code: "VIEW_EXPIRED" }), []);
	return { state, run };
}
