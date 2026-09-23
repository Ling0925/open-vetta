import { Button } from "../renderer/shared/components/ui/button";
import { Input } from "../renderer/shared/components/ui/input";
import { useEffect, useMemo, useState } from "react";
import type { WebAccessProjectSnapshot } from "../shared/web-access.js";
import { getWebCopy } from "./copy.js";
import { useProjectSync } from "./use-project-sync.js";
import { WebAccessClientError, bootstrap, logout, pair } from "./web-api.js";

export function WebApp(): JSX.Element {
	const copy = useMemo(() => getWebCopy(), []);
	const [phase, setPhase] = useState<"booting" | "pairing" | "ready">("booting");
	const [csrf, setCsrf] = useState<string>();
	const [pairCode, setPairCode] = useState("");
	const [pairBusy, setPairBusy] = useState(false);
	// 手动刷新用：重新拉一次完整快照，而不是重启整个引导流程。
	const [syncNonce, setSyncNonce] = useState(0);
	const [error, setError] = useState<string>();
	const [bootstrapNonce, setBootstrapNonce] = useState(0);
	// 同步状态与快照都由订阅管理：断线后它自己重连，组件不重跑引导流程。
	const sync = useProjectSync(phase === "ready" ? csrf : undefined, { restartKey: syncNonce });

	// 授权被撤销（或到期）时，观察流无法自行恢复：退回配对表单并说明原因。
	useEffect(() => {
		if (sync.status !== "revoked") return;
		setCsrf(undefined);
		setError(copy.revoked);
		setPhase("pairing");
	}, [copy.revoked, sync.status]);

	useEffect(() => {
		const controller = new AbortController();
		setPhase("booting");
		void bootstrap(controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				setCsrf(result.csrf);
				setError(undefined);
				setPhase("ready");
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return;
				if (cause instanceof WebAccessClientError && cause.status === 401) {
					// 还没配对过，或者授权已被撤销：两种情况都要求重新配对。
					setError(copy.revoked);
					setPhase("pairing");
					return;
				}
				// 宿主不可达不等于授权失效，文案不要引导用户重新配对。
				setError(copy.offline);
				setPhase("pairing");
			});
		return () => controller.abort();
	}, [bootstrapNonce, copy.offline, copy.revoked]);
	const handlePair = async (): Promise<void> => {
		const code = pairCode.trim();
		if (!code) {
			setError(copy.invalidCode);
			return;
		}
		setPairBusy(true);
		setError(undefined);
		try {
			const result = await pair(code);
			setCsrf(result.csrf);
			setPairCode("");
			setPhase("ready");
		} catch {
			setError(copy.pairingFailed);
		} finally {
			setPairBusy(false);
		}
	};

	const handleLogout = async (): Promise<void> => {
		if (!csrf) return;
		try {
			await logout(csrf);
		} finally {
			setCsrf(undefined);
			setPhase("pairing");
			setError(undefined);
		}
	};

	if (phase !== "ready" || !csrf) {
		return (
			<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
				<div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center justify-center">
					<section className="w-full rounded-xl border border-border/50 bg-card/60 p-6 backdrop-blur-sm sm:p-8">
						<p className="mb-2 text-[12px] font-medium uppercase tracking-[0.16em] text-primary">{copy.title}</p>
						<h1 className="text-[20px] font-semibold text-foreground">{copy.pairTitle}</h1>
						<p className="mt-2 text-[13px] leading-6 text-muted-foreground">{copy.pairHint}</p>
						{phase === "booting" ? (
							<p className="mt-6 text-[13px] text-muted-foreground" aria-live="polite">
								{copy.pairing}
							</p>
						) : (
							<form
								className="mt-6 space-y-4"
								onSubmit={(event) => {
									event.preventDefault();
									void handlePair();
								}}
							>
								<label className="block text-[13px] font-medium text-foreground" htmlFor="pair-code">
									{copy.pairCode}
								</label>
								<Input
									id="pair-code"
									value={pairCode}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setPairCode(event.target.value)}
								/>
								<Button type="submit" disabled={pairBusy}>
									{pairBusy ? copy.pairing : copy.pairAction}
								</Button>
							</form>
						)}
						{error ? (
							<p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
								{error}
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
						<Button variant="ghost" onClick={() => void handleLogout()}>
							{copy.logout}
						</Button>
					</div>
				</header>
				{error ? (
					<div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">
						{error}
					</div>
				) : null}
				<div className="mb-4 flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
					<span className={`h-2.5 w-2.5 rounded-full ${sync.status === "synced" ? "bg-emerald-500/80" : "bg-amber-500/80"}`} />
					{sync.status === "synced"
						? copy.synced
						: sync.status === "offline"
							? `${copy.offline} ${copy.reconnecting}`
							: sync.status === "revoked"
								? copy.revoked
								: copy.waiting}
				</div>
				{sync.snapshot ? (
					<div className="space-y-6">
						<ProjectGroup
							title={copy.current}
							entries={sync.snapshot.projects}
							emptyLabel={copy.noProjects}
							pathLabel={copy.path}
						/>
						<ProjectGroup
							title={copy.archived}
							entries={sync.snapshot.archivedProjects}
							emptyLabel={copy.noProjects}
							pathLabel={copy.path}
						/>
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
