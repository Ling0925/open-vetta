import { Button } from "../renderer/shared/components/ui/button";
import { Input } from "../renderer/shared/components/ui/input";
import { useEffect, useMemo, useState } from "react";
import type { WebAccessProjectSnapshot } from "../shared/web-access.js";
import { getWebCopy } from "./copy.js";
import { useProjectSync } from "./use-project-sync.js";
import { useWebSession } from "./use-web-session.js";

export function WebApp(): JSX.Element {
	const copy = useMemo(() => getWebCopy(), []);
	const session = useWebSession(copy);
	const [syncNonce, setSyncNonce] = useState(0);
	const sync = useProjectSync(session.phase === "ready" ? session.csrf : undefined, { restartKey: syncNonce });

	useEffect(() => {
		if (session.phase === "ready" && sync.status === "revoked" && sync.forCsrf === session.csrf) session.revoke();
	}, [session.phase, session.csrf, session.revoke, sync.status, sync.forCsrf]);

	if (session.phase !== "ready" || !session.csrf) {
		return (
			<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
				<div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center justify-center">
					<section className="w-full rounded-xl border border-border/50 bg-card/60 p-6 backdrop-blur-sm sm:p-8">
						<p className="mb-2 text-[12px] font-medium uppercase tracking-[0.16em] text-primary">{copy.title}</p>
						<h1 className="text-[20px] font-semibold text-foreground">{copy.pairTitle}</h1>
						<p className="mt-2 text-[13px] leading-6 text-muted-foreground">
							{session.phase === "pairing" ? copy.pairHint : copy.restoreHint}
						</p>
						{session.phase === "booting" || session.phase === "offline" ? (
							<div className="mt-6 space-y-3" role="status" aria-live="polite">
								<p className="text-[13px] text-muted-foreground">
									{session.phase === "offline" ? `${copy.offline} ${copy.reconnecting}` : copy.pairing}
								</p>
								{session.phase === "offline" ? (
									<Button variant="outline" onClick={session.retryBootstrap}>{copy.retryNow}</Button>
								) : null}
							</div>
						) : (
							<form
								className="mt-6 space-y-4"
								onSubmit={(event) => {
									event.preventDefault();
									void session.submitPair();
								}}
							>
								<label className="block text-[13px] font-medium text-foreground" htmlFor="pair-code">
									{copy.pairCode}
								</label>
								<Input
									id="pair-code"
									value={session.pairCode}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => session.setPairCode(event.target.value)}
								/>
								<Button type="submit" disabled={session.pairBusy}>
									{session.pairBusy ? copy.pairing : copy.pairAction}
								</Button>
							</form>
						)}
						{session.error ? (
							<p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
								{session.error}
							</p>
						) : null}
					</section>
				</div>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-8 sm:py-8">
			<div className="mx-auto w-full max-w-4xl">
				<header className="mb-6 flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="text-[12px] font-medium uppercase tracking-[0.16em] text-primary">{copy.title}</p>
						<h1 className="mt-1 text-[20px] font-semibold text-foreground">{copy.projectsTitle}</h1>
						<p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">{copy.projectsHint}</p>
					</div>
					<div className="flex items-center gap-2">
						<span className="rounded-full border border-border/60 bg-card/50 px-3 py-1 text-[12px] text-muted-foreground">{copy.readOnly}</span>
						<Button variant="outline" onClick={() => setSyncNonce((value) => value + 1)}>
							{copy.refresh}
						</Button>
						<Button variant="ghost" disabled={session.logoutBusy} onClick={() => void session.signOut()}>
							{session.logoutBusy ? copy.signingOut : copy.logout}
						</Button>
					</div>
				</header>
				{session.error ? (
					<div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
						{session.error}
					</div>
				) : null}
				<div className="mb-4 flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
					<span className={`h-2.5 w-2.5 rounded-full ${sync.forCsrf === session.csrf && sync.status === "synced" ? "bg-emerald-500/80" : "bg-amber-500/80"}`} />
					{sync.forCsrf !== session.csrf
						? copy.waiting
						: sync.status === "synced"
							? copy.synced
							: sync.status === "offline"
								? `${copy.offline} ${copy.reconnecting}`
								: sync.status === "revoked"
									? copy.revoked
									: copy.waiting}
				</div>
				{sync.forCsrf === session.csrf && sync.snapshot ? (
					<div className="space-y-6">
						<ProjectGroup title={copy.current} entries={sync.snapshot.projects} emptyLabel={copy.noProjects} pathLabel={copy.path} />
						<ProjectGroup title={copy.archived} entries={sync.snapshot.archivedProjects} emptyLabel={copy.noProjects} pathLabel={copy.path} />
					</div>
				) : null}
			</div>
		</main>
	);
}

function ProjectGroup({
	title,
	entries,
	emptyLabel,
	pathLabel,
}: {
	readonly title: string;
	readonly entries: readonly WebAccessProjectSnapshot["projects"][number][];
	readonly emptyLabel: string;
	readonly pathLabel: string;
}): JSX.Element {
	return (
		<section>
			<h2 className="mb-3 text-[14px] font-semibold text-foreground">{title}</h2>
			{entries.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border/60 bg-card/20 px-4 py-5 text-[13px] text-muted-foreground">{emptyLabel}</div>
			) : (
				<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
					{entries.map((entry) => (
						<article key={entry.path} className="rounded-xl border border-border/50 bg-card/40 px-3.5 py-3 backdrop-blur-sm">
							<h3 className="truncate text-[14px] font-medium text-foreground">{entry.name || entry.path}</h3>
							<p className="mt-1 break-all text-[12px] leading-5 text-muted-foreground">
								<span className="mr-1 text-muted-foreground/70">{pathLabel}:</span>
								{entry.path}
							</p>
						</article>
					))}
				</div>
			)}
		</section>
	);
}
