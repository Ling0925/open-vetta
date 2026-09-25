import { useTranslation } from "react-i18next";
import { Button } from "@shared/components/ui/button";
import { OrphanRemoteProjectGuard } from "@domains/project/components/orphan-remote/OrphanRemoteProjectGuard";
import { pageHeaderRightSlotAtom } from "@shared/store/atoms";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useThemeSurface } from "@vetta-org/theme-sdk/appearance";
import { useSetAtom } from "jotai";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { NewSessionHeaderActions } from "./new-session/NewSessionHeaderActions";
import { NewSessionPageView } from "./new-session/NewSessionPageView";
import { useNewSessionPageModel } from "./new-session/useNewSessionPageModel";

const CodexWorkspacePage = lazy(async () => ({
	default: (await import("../../codex-workspace/CodexWorkspacePage")).CodexWorkspacePage,
}));

export function NewSessionPage(): JSX.Element {
	const search = useSearch({ strict: false }) as { cwd?: string; target?: string };
	const { t } = useTranslation("codex");
	if (search.target === "runtime:codex") {
		return <Suspense fallback={<p role="status">{t("loading")}</p>}><CodexWorkspacePage /></Suspense>;
	}
	return (
		<OrphanRemoteProjectGuard cwd={search.cwd ? decodeURIComponent(search.cwd) : null}>
			<NewSessionPageContent />
		</OrphanRemoteProjectGuard>
	);
}

function NewSessionPageContent(): JSX.Element {
	const navigate = useNavigate();
	const { t } = useTranslation("codex");
	const surface = useThemeSurface("chat.newSessionPage");
	const model = useNewSessionPageModel();
	const setHeaderRightSlot = useSetAtom(pageHeaderRightSlotAtom);

	const headerActions = useMemo(
		() => (
			<div className="no-drag flex items-center gap-2.5">
				<Button variant="outline" onClick={() => void navigate({ to: "/new-session", search: { target: "runtime:codex" } })}>{t("shortcut")}</Button>
				<NewSessionHeaderActions
					activityOpen={model.activityOpen}
					onToggleActivity={model.onToggleActivity}
					onTogglePin={model.onTogglePin}
					panelTitle={model.panelTitle}
					pinTitle={model.pinTitle}
					pinned={model.pinned}
				/>
			</div>
		),
		[
			navigate,
			t,
			model.activityOpen,
			model.onToggleActivity,
			model.onTogglePin,
			model.panelTitle,
			model.pinTitle,
			model.pinned,
		],
	);

	useEffect(() => {
		setHeaderRightSlot(headerActions);
		return () => setHeaderRightSlot(null);
	}, [headerActions, setHeaderRightSlot]);

	return <NewSessionPageView {...model} className={surface?.rootClassName} />;
}
