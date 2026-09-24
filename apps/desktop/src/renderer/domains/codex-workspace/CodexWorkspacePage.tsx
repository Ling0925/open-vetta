import { type ReactElement, useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Textarea } from "@shared/components/ui/textarea";
import { Button } from "@shared/components/ui/button";
import { codexWorkspaceDraftsAtom } from "@shared/store/atoms";
import type { CodexWorkspaceProfile } from "../../../shared/codex-workspace";
import { useCodexWorkspace } from "./useCodexWorkspace";
import { CodexProfileForm } from "./CodexProfileForm";
import { CodexTranscript } from "./CodexTranscript";

export function CodexWorkspacePage(): ReactElement {
	const { t } = useTranslation("codex"); const navigate = useNavigate();
	const [attempt, retry] = useState(0); const { state, run } = useCodexWorkspace(attempt);
	const data = state.snapshot; const [drafts, setDrafts] = useAtom(codexWorkspaceDraftsAtom);
	const scope = data?.sessionId ?? "new"; const draft = drafts[scope] ?? "";
	const submitted = useRef<{ sessionId: string; text: string; id: string } | undefined>(undefined);
	const [sending, setSending] = useState(false);
	const [savedSession, selectSavedSession] = useState("");
	const changedDraft = (value: string) => setDrafts(previous => ({ ...previous, [scope]: value }));
	const editable = state.connection === "ready" && !state.pending.includes("open") && !state.pending.includes("close");
	const ready = editable && data?.phase === "ready" && !!data.sessionId;
	const running = data?.phase === "running" || data?.phase === "stopping";
	const code = state.errorCode ?? data?.errorCode;
	useEffect(() => {
		const sent = submitted.current;
		if (!sent || sent.sessionId !== data?.sessionId || data.activeInputId || !data.outcome) return;
		if (data.outcome === "completed") setDrafts(previous => previous[sent.sessionId] === sent.text ? { ...previous, [sent.sessionId]: "" } : previous);
		submitted.current = undefined;
	}, [data, setDrafts]);
	const send = async () => {
		if (!ready || !data?.sessionId || !draft.trim() || sending) return;
		setSending(true);
		const pending = submitted.current;
		const id = pending?.sessionId === data.sessionId && pending.text === draft ? pending.id : crypto.randomUUID();
		submitted.current = { sessionId: data.sessionId, text: draft, id };
		try {
			const reply = await run({ type: "send", sessionId: data.sessionId, inputId: id, text: draft });
			// Keep text after rejected/uncertain delivery. A transport retry can reuse the same input identity.
			if (!reply.ok && reply.code !== "CONNECTION_LOST") submitted.current = undefined;
		} finally { setSending(false); }
	};
	const open = async (sessionId?: string) => {
		const reply = await run({ type: "open", ...(sessionId ? { sessionId } : {}) });
		if (!sessionId && reply.ok && reply.snapshot?.sessionId) {
			const id = reply.snapshot.sessionId;
			setDrafts(previous => previous.new && !previous[id] ? { ...previous, [id]: previous.new, new: "" } : previous);
		}
	};
	const configure = (profile: CodexWorkspaceProfile) => run({ type: "configure", profile });
	return (
		<section className="flex min-h-0 flex-1 flex-col overflow-auto px-8 pb-8 text-[13px]">
			<div className="drag-region h-12 shrink-0" />
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div><h1 className="text-[20px] font-semibold">{t("title")}</h1><p className="text-muted-foreground">{t("subtitle")}</p></div>
				<Button variant="outline" onClick={() => void navigate({ to: "/new-session", search: {} })}>{t("native")}</Button>
			</header>
			<p className="my-3 text-muted-foreground">{t("limits")}</p>
			{state.connection === "loading" && <p role="status">{t("loading")}</p>}
			{state.connection === "failed" && <Button variant="outline" onClick={() => retry(value => value + 1)}>{t("reconnect")}</Button>}
			{code && <div role="alert" className="my-3 text-destructive"><p>{t("errorHelp")}</p><details><summary>{t("technical")}</summary><code>{code}</code></details></div>}
			{data && <>
				<p role="status" className="my-3">{t(`phases.${data.phase}`)}{data.outcome ? ` · ${t(`outcomes.${data.outcome}`)}` : ""}</p>
				{!data.sessionId && data.phase !== "opening" && data.phase !== "closing" && <CodexProfileForm key={JSON.stringify(data.profile)}
					initial={data.profile} disabled={!editable || state.pending.includes("configure")} save={configure}
					choose={async field => { const reply = await run({ type: "choose", field }); return reply.ok ? reply.chosenPath : undefined; }} />}
				{!data.sessionId && <div className="my-4 flex flex-wrap gap-3">
					<Button disabled={!editable || !data.profile || state.pending.includes("configure") || data.phase !== "ready"}
						onClick={() => void open()}>{t("create")}</Button>
					{data.sessions.length > 0 && <>
						<label className="self-center" htmlFor="codex-saved-session">{t("savedSessions")}</label>
						<select id="codex-saved-session" className="min-w-0 max-w-full rounded-lg border border-border bg-background p-2"
							value={data.sessions.some(item => item.id === savedSession) ? savedSession : ""} onChange={event => selectSavedSession(event.target.value)}>
							<option value="">{t("chooseSession")}</option>
							{data.sessions.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}
						</select>
						<Button variant="outline" disabled={!editable || data.phase !== "ready" || !data.sessions.some(item => item.id === savedSession)}
							onClick={() => void open(savedSession)}>{t("resumeSelected")}</Button>
					</>}
				</div>}
				{(data.sessionId || data.phase === "opening" || data.phase === "closing") && <div className="my-3 flex flex-wrap gap-3">
					{data.sessionId && <span className="self-center text-muted-foreground">{data.profile?.cwd}</span>}
					<Button variant="outline" disabled={state.pending.includes("close")}
						onClick={() => void run({ type: "close" })}>{t("close")}</Button>
				</div>}
				{data.approvals.map(approval => <section key={approval.id} className="my-3 rounded-xl border border-border p-4" aria-label={t("approvalTitle")}>
					<h2 className="font-semibold">{t("approvalTitle")}</h2><p>{t("approvalScope")}</p>
					<pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap break-all">{approval.details}</pre>
					<div className="flex gap-3">
						<Button variant="outline" disabled={state.pending.includes("approval")}
							onClick={() => void run({ type: "approval", approvalId: approval.id, decision: "decline" })}>{t("decline")}</Button>
						<Button disabled={state.pending.includes("approval") || !running || data.phase === "stopping"}
							onClick={() => void run({ type: "approval", approvalId: approval.id, decision: "accept" })}>{t("acceptOnce")}</Button>
					</div>
				</section>)}
				<CodexTranscript rows={data.rows} hasEarlierRows={data.hasEarlierRows} labels={{
					title: t("conversation"), empty: t("empty"), earlier: t("earlier"), truncated: t("truncated"),
					user: t("roles.user"), assistant: t("roles.assistant"), thinking: t("roles.thinking"), tool: t("roles.tool"), error: t("roles.error"), note: t("roles.note"),
				}} />
				<form className="mt-4" onSubmit={event => { event.preventDefault(); void send(); }}>
					<label className="block" htmlFor="codex-prompt">{t("prompt")}</label>
					<Textarea id="codex-prompt" className="my-2 min-h-24 w-full rounded-lg border border-border bg-background p-3"
						value={draft} maxLength={100000} onChange={event => changedDraft(event.target.value)} />
					<p className="text-muted-foreground">{t("draftHelp")}</p>
					<div className="mt-3 flex gap-3">
						<Button type="submit" disabled={!ready || sending || !draft.trim()}>{t("send")}</Button>
						<Button type="button" variant="outline" disabled={!running || !data.activeInputId || state.pending.includes("stop")}
							onClick={() => data.activeInputId && data.sessionId && void run({ type: "stop", sessionId: data.sessionId, inputId: data.activeInputId })}>{t("stop")}</Button>
					</div>
				</form>
			</>}
		</section>
	);
}
