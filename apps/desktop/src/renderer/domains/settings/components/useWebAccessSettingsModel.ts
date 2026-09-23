import { useCallback, useEffect, useState } from "react";
import type { WebAccessPairResult, WebAccessState } from "../../../../shared/web-access.js";

export const DEFAULT_WEB_ACCESS_PORT = 45821;

export interface WebAccessSettingsModel {
	readonly state: WebAccessState;
	readonly origin: string;
	readonly port: string;
	readonly pairing?: WebAccessPairResult;
	readonly busy: boolean;
	readonly error?: string;
	readonly setOrigin: (value: string) => void;
	readonly setPort: (value: string) => void;
	readonly configure: () => Promise<void>;
	readonly enable: () => Promise<void>;
	readonly disable: () => Promise<void>;
	readonly pair: () => Promise<void>;
	readonly revoke: (grantId?: string) => Promise<void>;
}

export function useWebAccessSettingsModel(): WebAccessSettingsModel {
	const [state, setState] = useState<WebAccessState>({ status: "disabled", generation: 0, grants: [] });
	const [origin, setOrigin] = useState("");
	const [port, setPort] = useState(String(DEFAULT_WEB_ACCESS_PORT));
	const [pairing, setPairing] = useState<WebAccessPairResult>();
	const [busy, setBusy] = useState(false);
	const [draftDirty, setDraftDirty] = useState(false);
	const [error, setError] = useState<string>();

	const sync = useCallback(
		async (preserveError = false): Promise<void> => {
			try {
				const next = await window.vetta.webAccess.getState();
				setState(next);
				if (next.config && !draftDirty) {
					setOrigin(next.config.origin);
					setPort(String(next.config.port));
				}
				setError((current) => (preserveError && current ? current : next.error));
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[draftDirty],
	);

	useEffect(() => {
		void sync();
		const timer = window.setInterval(() => void sync(true), 2_000);
		return () => window.clearInterval(timer);
	}, [sync]);

	const run = useCallback(
		async (operation: () => Promise<WebAccessState>): Promise<void> => {
			setBusy(true);
			setError(undefined);
			try {
				setState(await operation());
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				await sync(true);
			} finally {
				setBusy(false);
			}
		},
		[sync],
	);

	return {
		state,
		origin,
		port,
		pairing,
		busy,
		error,
		setOrigin: (value) => {
			setDraftDirty(true);
			setOrigin(value);
		},
		setPort: (value) => {
			setDraftDirty(true);
			setPort(value);
		},
		configure: () =>
			run(async () => {
				const next = await window.vetta.webAccess.configure({ origin: origin.trim(), port: Number(port) });
				setDraftDirty(false);
				return next;
			}),
		enable: () => run(() => window.vetta.webAccess.enable()),
		disable: () =>
			run(async () => {
				setPairing(undefined);
				return await window.vetta.webAccess.disable();
			}),
		pair: async () => {
			setBusy(true);
			setError(undefined);
			try {
				setPairing(await window.vetta.webAccess.pair());
				setState(await window.vetta.webAccess.getState());
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setBusy(false);
			}
		},
		revoke: (grantId) =>
			run(async () => {
				if (!grantId) setPairing(undefined);
				return await window.vetta.webAccess.revoke(grantId);
			}),
	};
}
