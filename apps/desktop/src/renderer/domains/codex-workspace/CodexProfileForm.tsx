import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@shared/components/ui/input";
import { Button } from "@shared/components/ui/button";
import type { CodexWorkspaceProfile, CodexWorkspaceReply } from "../../../shared/codex-workspace";

export function CodexProfileForm({ initial, disabled, save, choose }: {
	initial?: CodexWorkspaceProfile; disabled: boolean;
	save(profile: CodexWorkspaceProfile): Promise<CodexWorkspaceReply>;
	choose(field: "executable" | "cwd" | "codexHome"): Promise<string | undefined>;
}): ReactElement {
	const { t } = useTranslation("codex");
	const [value, setValue] = useState<CodexWorkspaceProfile>(initial ?? {
		executable: "", expectedVersion: "", codexHome: "", cwd: "", sandbox: "read-only",
	});
	return <form onSubmit={event => { event.preventDefault(); void save(value); }} className="my-3">
		<fieldset disabled={disabled} className="space-y-3">
			<legend className="mb-3 font-semibold">{t("configuration")}</legend>
			<p className="text-muted-foreground">{t("profileWarning")}</p>
			{(["executable", "expectedVersion", "codexHome", "cwd", "model"] as const).map(field => <div key={field}>
				<label htmlFor={`codex-${field}`} className="block">{t(`fields.${field}`)}</label>
				<div className="flex gap-2.5">
					<Input id={`codex-${field}`} className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2"
						value={value[field] ?? ""} required={field !== "model"} maxLength={field === "model" ? 200 : field === "expectedVersion" ? 64 : 4096}
						onChange={event => setValue(previous => ({ ...previous, [field]: event.target.value }))} />
					{(field === "executable" || field === "codexHome" || field === "cwd") && <Button type="button" variant="outline"
						onClick={() => void choose(field).then(path => { if (path) setValue(previous => ({ ...previous, [field]: path })); })}>{t("browse")}</Button>}
				</div>
			</div>)}
			<label className="block" htmlFor="codex-sandbox">{t("fields.sandbox")}</label>
			<select id="codex-sandbox" className="rounded-lg border border-border bg-background p-2" value={value.sandbox}
				onChange={event => setValue(previous => ({ ...previous, sandbox: event.target.value === "workspace-write" ? "workspace-write" : "read-only" }))}>
				<option value="read-only">{t("permissions.read-only")}</option>
				<option value="workspace-write">{t("permissions.workspace-write")}</option>
			</select>
			<p className="text-muted-foreground">{t("versionHelp")}</p>
			<Button type="submit" variant="outline">{t("save")}</Button>
		</fieldset>
	</form>;
}
