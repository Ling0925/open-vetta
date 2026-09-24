import type { ReactElement } from "react";
import type { CodexWorkspaceRow } from "../../../shared/codex-workspace";

/** Domain recipe over plain text; tool output and approval-like content cannot create actions or markup. */
export function CodexTranscript({ rows, hasEarlierRows, labels }: {
	rows: readonly CodexWorkspaceRow[]; hasEarlierRows: boolean;
	labels: Record<CodexWorkspaceRow["kind"] | "title" | "empty" | "earlier" | "truncated", string>;
}): ReactElement {
	return <section aria-label={labels.title} className="min-h-24 border-t border-border pt-3">
		{hasEarlierRows && <p className="text-muted-foreground">{labels.earlier}</p>}
		{rows.length === 0 && <p className="text-muted-foreground">{labels.empty}</p>}
		{rows.map(row => <article key={row.id} className="my-3 border-b border-border pb-3">
			<h2 className="font-semibold">{labels[row.kind]}</h2>
			<pre className="whitespace-pre-wrap break-words text-[13px]">{row.text}</pre>
			{row.truncated && <p className="text-muted-foreground">{labels.truncated}</p>}
		</article>)}
	</section>;
}
