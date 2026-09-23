import { useCallback, useEffect, useRef, useState } from "react";
import type { WebCopy } from "./copy.js";
import { retryDelay, waitForRetry } from "./retry.js";
import { bootstrap, logout, pair, WebAccessClientError } from "./web-api.js";

type SessionPhase = "booting" | "offline" | "pairing" | "ready";

interface SessionState {
	readonly phase: SessionPhase;
	readonly csrf?: string;
	readonly error?: string;
}

/** Browser authorization belongs to the page, not to the project observation stream. */
export function useWebSession(copy: WebCopy) {
	const [session, setSession] = useState<SessionState>({ phase: "booting" });
	const [pairCode, setPairCode] = useState("");
	const [pairBusy, setPairBusy] = useState(false);
	const [logoutBusy, setLogoutBusy] = useState(false);
	const [bootstrapNonce, setBootstrapNonce] = useState(0);
	const pairRequest = useRef<AbortController | null>(null);
	const logoutRequest = useRef<AbortController | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: bootstrapNonce 是手动重试触发器，不是需要读取的值
	useEffect(() => {
		const controller = new AbortController();
		void restore();
		return () => controller.abort();

		async function restore(): Promise<void> {
			let attempt = 0;
			while (!controller.signal.aborted) {
				try {
					const result = await bootstrap(controller.signal);
					if (controller.signal.aborted) return;
					setSession({ phase: "ready", csrf: result.csrf });
					return;
				} catch (cause: unknown) {
					if (controller.signal.aborted) return;
					if (cause instanceof WebAccessClientError && cause.status === 401) {
						setSession({ phase: "pairing" });
						return;
					}
					setSession({ phase: "offline" });
					const delay = retryDelay(attempt);
					attempt += 1;
					if (!(await waitForRetry(delay, controller.signal))) return;
				}
			}
		}
	}, [bootstrapNonce]);

	useEffect(
		() => () => {
			pairRequest.current?.abort();
			logoutRequest.current?.abort();
		},
		[],
	);

	const retryBootstrap = (): void => {
		setSession({ phase: "booting" });
		setBootstrapNonce((value) => value + 1);
	};

	const submitPair = async (): Promise<void> => {
		if (pairBusy || session.phase !== "pairing") return;
		const code = pairCode.trim();
		if (!code) {
			setSession({ phase: "pairing", error: copy.invalidCode });
			return;
		}
		const controller = new AbortController();
		pairRequest.current = controller;
		setPairBusy(true);
		setSession({ phase: "pairing" });
		try {
			const result = await pair(code, controller.signal);
			if (controller.signal.aborted) return;
			setSession({ phase: "ready", csrf: result.csrf });
			setPairCode("");
		} catch {
			if (!controller.signal.aborted) setSession({ phase: "pairing", error: copy.pairingFailed });
		} finally {
			if (pairRequest.current === controller) pairRequest.current = null;
			if (!controller.signal.aborted) setPairBusy(false);
		}
	};

	const signOut = async (): Promise<void> => {
		if (logoutBusy || session.phase !== "ready" || !session.csrf) return;
		const controller = new AbortController();
		logoutRequest.current = controller;
		setLogoutBusy(true);
		setSession({ phase: "ready", csrf: session.csrf });
		try {
			await logout(session.csrf, controller.signal);
			if (controller.signal.aborted) return;
			setSession({ phase: "pairing" });
		} catch (cause: unknown) {
			if (controller.signal.aborted) return;
			if (cause instanceof WebAccessClientError && cause.status === 401) {
				setSession({ phase: "pairing", error: copy.revoked });
			} else {
				setSession({ phase: "ready", csrf: session.csrf, error: copy.logoutUnconfirmed });
			}
		} finally {
			if (logoutRequest.current === controller) logoutRequest.current = null;
			if (!controller.signal.aborted) setLogoutBusy(false);
		}
	};

	const revoke = useCallback(() => {
		logoutRequest.current?.abort();
		setLogoutBusy(false);
		setSession((current) => (current.phase === "ready" ? { phase: "pairing", error: copy.revoked } : current));
	}, [copy.revoked]);

	return {
		...session,
		pairCode,
		setPairCode,
		pairBusy,
		logoutBusy,
		retryBootstrap,
		submitPair,
		signOut,
		revoke,
	};
}
