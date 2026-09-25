import { Button } from "@shared/components/ui/button";
import type { RuntimeBackendSelectorModel } from "../../hooks/useRuntimeBackendModel";

/** A toolbar control, not a second conversation surface. Labels are prepared by the connector. */
export function RuntimeBackendSelector({ model }: { model: RuntimeBackendSelectorModel }) {
	return (
		<div role="group" aria-label={model.label} aria-busy={!!model.status} title={model.help}
			className="no-drag flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] p-0.5">
			{(["native", "codex"] as const).map(backend => (
				<Button key={backend} type="button" size="sm" variant={model.backend === backend ? "secondary" : "ghost"}
					className="h-6 px-2 text-[11px]" disabled={model.disabled} aria-pressed={model.backend === backend}
					onClick={() => model.select(backend)}>
					{backend === "native" ? "Native" : "Codex"}
				</Button>
			))}
		</div>
	);
}
