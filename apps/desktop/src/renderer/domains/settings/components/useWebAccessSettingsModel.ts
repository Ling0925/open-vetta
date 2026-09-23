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
	readonly selectLanAddress: (address: string) => void;
	readonly disable: () => Promise<void>;
	readonly pair: () => Promise<void>;
	readonly revoke: (grantId?: string) => Promise<void>;
}

export function useWebAccessSettingsModel(): WebAccessSettingsModel {
	const [state, setState] = useState<WebAccessState>({
		status: "disabled",
		generation: 0,
		grants: [],
		lanAddresses: [],
	});
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
				if (next.status !== "enabled") setPairing(undefined);
				if (!draftDirty) {
					const address = next.lanAddresses[0];
					const port = next.config?.port ?? DEFAULT_WEB_ACCESS_PORT;
					const configuredOrigin = next.config?.origin;
					const configuredAddress = configuredOrigin?.startsWith("http://")
						? new URL(configuredOrigin).hostname
						: undefined;
					const staleLanAddress =
						next.status !== "enabled" &&
						configuredAddress &&
						configuredAddress !== "127.0.0.1" &&
						!next.lanAddresses.includes(configuredAddress);
					const currentLanOrigin = address ? `http://${address}:${port}` : "";
					setOrigin(staleLanAddress ? currentLanOrigin : (configuredOrigin ?? currentLanOrigin));
					setPort(String(port));
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
			setOrigin((current) => {
				const address = state.lanAddresses.find((item) => current === `http://${item}:${port}`);
				return address ? `http://${address}:${value}` : current;
			});
			setPort(value);
		},
		selectLanAddress: (address) => {
			if (!state.lanAddresses.includes(address)) return;
			setDraftDirty(true);
			setOrigin(`http://${address}:${port}`);
		},
		disable: () =>
			run(async () => {
				setPairing(undefined);
				return await window.vetta.webAccess.disable();
			}),
		pair: async () => {
			setBusy(true);
			setError(undefined);
			try {
				if (state.status !== "enabled") {
					const configured = await window.vetta.webAccess.configure({ origin: origin.trim(), port: Number(port) });
					setState(configured);
					setState(await window.vetta.webAccess.enable());
					setDraftDirty(false);
				}
				setPairing(await window.vetta.webAccess.pair());
				setState(await window.vetta.webAccess.getState());
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				await sync(true);
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
