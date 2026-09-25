import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/components/ui/select";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CodexModelChoice,
	CodexRuntimeDefaults,
	CodexWorkspaceProfile,
	CodexWorkspaceReply,
} from "../../../shared/codex-workspace";

export function CodexProfileForm({
	initial,
	runtimeDefaults,
	disabled,
	save,
	choose,
	models = [],
	modelsStatus = "loading",
	reloadModels,
}: {
	initial?: CodexWorkspaceProfile;
	runtimeDefaults?: CodexRuntimeDefaults;
	disabled: boolean;
	save(profile: CodexWorkspaceProfile): Promise<CodexWorkspaceReply>;
	choose(field: "executable" | "cwd" | "codexHome"): Promise<string | undefined>;
	models?: readonly CodexModelChoice[];
	modelsStatus?: "loading" | "ready" | "failed";
	reloadModels?(): void;
}): ReactElement {
	const { t } = useTranslation("codex");
	const [value, setValue] = useState<CodexWorkspaceProfile>(
		initial ?? {
			executable: "",
			expectedVersion: "",
			codexHome: "",
			cwd: "",
			sandbox: "read-only",
			...runtimeDefaults,
		},
	);
	// Preserve saved legacy profiles; new profiles use existing Vetta settings by default.
	const [source, setSource] = useState<"vetta" | "codex">(!initial || initial.vettaModelKey ? "vetta" : "codex");
	const [modelKey, setModelKey] = useState(initial?.vettaModelKey ?? "");
	const selected = models.find((model) => model.modelKey === modelKey);
	useEffect(() => {
		if (initial?.vettaModelKey || modelKey || modelsStatus !== "ready") return;
		const existingDefault = models.find((model) => model.isDefault && !model.unavailable);
		if (existingDefault) setModelKey(existingDefault.modelKey);
	}, [initial?.vettaModelKey, modelKey, models, modelsStatus]);
	const canSave = source === "codex" || (modelsStatus === "ready" && selected && !selected.unavailable);
	const submit = () => {
		if (!canSave) return;
		const { model, vettaModelKey: _reference, ...runtime } = value;
		void save(
			source === "vetta" ? { ...runtime, vettaModelKey: modelKey } : { ...runtime, ...(model ? { model } : {}) },
		);
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			className="my-3"
		>
			<fieldset disabled={disabled} className="space-y-3">
				<legend className="mb-3 font-semibold">{t("configuration")}</legend>
				<label htmlFor="codex-model-source" className="block">
					{t("modelSource")}
				</label>
				<Select
					value={source}
					disabled={disabled}
					onValueChange={(next) => setSource(next === "vetta" ? "vetta" : "codex")}
				>
					<SelectTrigger id="codex-model-source">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="vetta">{t("existingModel")}</SelectItem>
						<SelectItem value="codex">{t("codexHomeModel")}</SelectItem>
					</SelectContent>
				</Select>
				{source === "vetta" && (
					<>
						<label htmlFor="codex-existing-model" className="block">
							{t("chooseModel")}
						</label>
						<Select value={modelKey} disabled={disabled || modelsStatus !== "ready"} onValueChange={setModelKey}>
							<SelectTrigger id="codex-existing-model" aria-describedby="codex-model-help">
								<SelectValue placeholder={t("chooseModel")} />
							</SelectTrigger>
							<SelectContent>
								{modelKey && !selected && (
									<SelectItem value={modelKey} disabled>
										{t("modelMissing")}
									</SelectItem>
								)}
								{models.map((model) => (
									<SelectItem key={model.modelKey} value={model.modelKey} disabled={!!model.unavailable}>
										{model.label}
										{model.unavailable ? ` — ${t("modelUnavailable")}` : ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{modelsStatus === "loading" && <output className="block">{t("modelLoading")}</output>}
						{modelsStatus === "failed" && <p role="alert">{t("modelLoadFailed")}</p>}
						{modelsStatus === "ready" && models.length === 0 && (
							<output className="block">{t("modelEmpty")}</output>
						)}
						{modelKey && modelsStatus === "ready" && (!selected || selected.unavailable) && (
							<p role="alert">{t("modelMissing")}</p>
						)}
						{selected?.baseUrl && <p className="break-all text-muted-foreground">{selected.baseUrl}</p>}
						<p id="codex-model-help" className="text-muted-foreground">
							{t("reuseHelp")} {t("responsesOnly")}
						</p>
						{reloadModels && (
							<Button
								type="button"
								variant="outline"
								onClick={reloadModels}
								disabled={modelsStatus === "loading"}
							>
								{t("refreshModels")}
							</Button>
						)}
					</>
				)}
				{runtimeDefaults && (
					<div>
						<output className="block">{t("bundledRuntime", { version: runtimeDefaults.expectedVersion })}</output>
						<Button
							type="button"
							variant="outline"
							onClick={() => setValue((previous) => ({ ...previous, ...runtimeDefaults }))}
						>
							{t("useBundledRuntime")}
						</Button>
					</div>
				)}
				<p className="text-muted-foreground">{t("profileWarning")}</p>
				{(
					[
						"executable",
						"expectedVersion",
						"codexHome",
						"cwd",
						...(source === "codex" ? ["model" as const] : []),
					] as const
				).map((field) => (
					<div key={field}>
						<label htmlFor={`codex-${field}`} className="block">
							{t(`fields.${field}`)}
						</label>
						<div className="flex gap-2.5">
							<Input
								id={`codex-${field}`}
								className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2"
								value={value[field] ?? ""}
								required={field !== "model"}
								maxLength={field === "model" ? 200 : field === "expectedVersion" ? 64 : 4096}
								onChange={(event) => setValue((previous) => ({ ...previous, [field]: event.target.value }))}
							/>
							{(field === "executable" || field === "codexHome" || field === "cwd") && (
								<Button
									type="button"
									variant="outline"
									onClick={() =>
										void choose(field).then((path) => {
											if (path) setValue((previous) => ({ ...previous, [field]: path }));
										})
									}
								>
									{t("browse")}
								</Button>
							)}
						</div>
					</div>
				))}
				{source === "vetta" && <p className="text-muted-foreground">{t("dataHomeHelp")}</p>}
				<label className="block" htmlFor="codex-sandbox">
					{t("fields.sandbox")}
				</label>
				<Select
					value={value.sandbox}
					disabled={disabled}
					onValueChange={(next) =>
						setValue((previous) => ({
							...previous,
							sandbox: next === "workspace-write" ? "workspace-write" : "read-only",
						}))
					}
				>
					<SelectTrigger id="codex-sandbox">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="read-only">{t("permissions.read-only")}</SelectItem>
						<SelectItem value="workspace-write">{t("permissions.workspace-write")}</SelectItem>
					</SelectContent>
				</Select>
				<p className="text-muted-foreground">{t("versionHelp")}</p>
				<Button type="submit" variant="outline" disabled={!canSave}>
					{t("save")}
				</Button>
			</fieldset>
		</form>
	);
}
