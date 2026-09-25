import { waitForCommittedPaint } from "@shared/lib/committed-paint";
import { activeInputDraftKeyAtom, draftRuntimeBackendsAtom } from "@shared/store/atoms";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRuntimeBackend, SessionRuntimeBackendState } from "../../../../shared/session-runtime-backend";

export interface RuntimeBackendSelectorModel {
	readonly backend?: SessionRuntimeBackend;
	readonly disabled: boolean;
	readonly label: string;
	readonly help: string;
	readonly status?: string;
	readonly error?: string;
	readonly retryLabel: string;
	select(backend: SessionRuntimeBackend): void;
	retry(): void;
}

/** Reads the actual session selection; changing the toolbar must never impersonate a successful backend switch. */
export function useRuntimeBackendModel(runtimeId: string | undefined, busy: boolean) {
	const { t } = useTranslation("codex");
	const draftKey = useAtomValue(activeInputDraftKeyAtom);
	const [drafts, setDrafts] = useAtom(draftRuntimeBackendsAtom);
	const [loaded, setLoaded] = useState<SessionRuntimeBackendState>();
	const [loading, setLoading] = useState(true);
	const [switching, setSwitching] = useState(false);
	const [error, setError] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	const scope = runtimeId ?? draftKey ?? "unbound";
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const selectionPending = useRef(false);
	const loadIdentity = useRef("");
	useEffect(() => {
		let cancelled = false;
		const identity = `${scope}:${attempt}`;
		loadIdentity.current = identity;
		const obsolete = () => cancelled || loadIdentity.current !== identity;
		selectionPending.current = false;
		setSwitching(false);
		setError(undefined);
		setLoaded(undefined);
		if (!runtimeId) {
			setLoading(false);
			return;
		}
		setLoading(true);
		let observedChange = 0;
		const remove = window.vetta.session.onRuntimeBackendChanged((state) => {
			if (obsolete() || state.sessionId !== runtimeId) return;
			observedChange++;
			setLoaded(state);
			setLoading(false);
		});
		void (async () => {
			await waitForCommittedPaint();
			if (obsolete()) return;
			const before = observedChange;
			const reply = await window.vetta.session.getRuntimeBackend(runtimeId);
			if (obsolete() || before !== observedChange) return;
			if (!reply.ok) throw new Error(reply.code);
			setLoaded(reply.state);
			setLoading(false);
		})().catch((reason) => {
			if (!obsolete()) {
				setError(reason instanceof Error ? reason.message : "RUNTIME_SWITCH_FAILED");
				setLoading(false);
			}
		});
		return () => {
			cancelled = true;
			remove();
		};
	}, [runtimeId, attempt, scope]);
	const state = loaded?.sessionId === runtimeId ? loaded : undefined;
	const backend = runtimeId ? state?.backend : draftKey ? (drafts[draftKey] ?? "native") : "native";
	const pending = switching || state?.switching === true;
	const unavailable = runtimeId ? loading || !state : !draftKey;
	const disabled = busy || pending || unavailable;
	const select = useCallback(
		async (next: SessionRuntimeBackend) => {
			if (disabled || selectionPending.current || next === backend) return;
			if (!runtimeId) {
				if (draftKey) setDrafts((previous) => ({ ...previous, [draftKey]: next }));
				return;
			}
			if (!state) return;
			selectionPending.current = true;
			setSwitching(true);
			setError(undefined);
			const origin = scope;
			try {
				await waitForCommittedPaint();
				if (currentScope.current !== origin) return;
				const reply = await window.vetta.session.setRuntimeBackend(runtimeId, next, state.selectionId);
				if (currentScope.current !== origin) return;
				if (!reply.ok) throw new Error(reply.code);
				setLoaded(reply.state);
			} catch (reason) {
				if (currentScope.current !== origin) return;
				setError(reason instanceof Error ? reason.message : "RUNTIME_SWITCH_FAILED");
				// A lost IPC response does not prove that persistence failed. Reconcile before allowing another send.
				try {
					const reply = await window.vetta.session.getRuntimeBackend(runtimeId);
					if (currentScope.current !== origin) return;
					setLoaded(reply.ok ? reply.state : undefined);
				} catch {
					if (currentScope.current === origin) setLoaded(undefined);
				}
			} finally {
				if (currentScope.current === origin) {
					selectionPending.current = false;
					setSwitching(false);
				}
			}
		},
		[backend, disabled, draftKey, runtimeId, scope, setDrafts, state],
	);
	const model: RuntimeBackendSelectorModel = {
		backend,
		disabled,
		label: t("chatBackend.label"),
		retryLabel: t("chatBackend.retry"),
		help: busy ? t("chatBackend.busy") : t("chatBackend.help"),
		status: pending ? t("chatBackend.switching") : unavailable ? t("chatBackend.loading") : undefined,
		error: error ? t(`chatBackend.errors.${error}`, { defaultValue: t("chatBackend.errors.DEFAULT") }) : undefined,
		select: (next) => {
			void select(next);
		},
		retry: () => setAttempt((value) => value + 1),
	};
	return { model, backend, blocked: pending || unavailable, switching: pending };
}
