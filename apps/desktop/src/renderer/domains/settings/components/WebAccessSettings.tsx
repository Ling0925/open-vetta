import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { useTranslation } from "react-i18next";
import { useWebAccessSettingsModel } from "./useWebAccessSettingsModel";

export function WebAccessSettings(): JSX.Element {
	const { t } = useTranslation("settings");
	const model = useWebAccessSettingsModel();
	const enabled = model.state.status === "enabled";
	const selectedAddress = model.state.lanAddresses.find((address) => model.origin === `http://${address}:${model.port}`) ?? "";

	return (
		<div className="mx-auto w-full max-w-[680px] px-8 pt-2 pb-8">
			<div className="mb-6">
				<h1 className="text-[20px] font-bold text-foreground">{t("webAccess.title")}</h1>
				<p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{t("webAccess.description")}</p>
			</div>

			<section className="mb-6 rounded-xl border border-border/50 bg-card/40 p-4">
				<h2 className="text-[14px] font-semibold text-foreground">{t("webAccess.serviceTitle")}</h2>
				<p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{t("webAccess.serviceHint")}</p>
				<p className="mt-3 text-[12px] text-muted-foreground" aria-live="polite">{t(`webAccess.status.${model.state.status}`)}</p>
				<p className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
					{t("webAccess.httpWarning")}
				</p>
				{!enabled && model.state.lanAddresses.length > 1 ? (
					<label className="mt-4 block text-[13px] font-medium text-foreground" htmlFor="web-access-network">
						{t("webAccess.networkLabel")}
						<select
							id="web-access-network"
							className="mt-2 h-8 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[13px] text-foreground focus-visible:border-ring"
							value={selectedAddress}
							disabled={model.busy || model.state.status === "starting"}
							onChange={(event) => model.selectLanAddress(event.target.value)}
						>
							{!selectedAddress ? <option value="">{t("webAccess.customAddress")}</option> : null}
							{model.state.lanAddresses.map((address) => <option key={address} value={address}>{address}</option>)}
						</select>
					</label>
				) : null}
				{model.origin ? (
					<code className="mt-3 block break-all text-[12px] text-foreground">{model.origin}</code>
				) : (
					<p className="mt-3 text-[12px] text-muted-foreground">{t("webAccess.noNetwork")}</p>
				)}
				<details className="mt-4 text-[12px] text-muted-foreground">
					<summary className="cursor-pointer select-none focus-visible:outline-ring">{t("webAccess.advanced")}</summary>
					<p className="mt-2 leading-relaxed">{t("webAccess.advancedHint")}</p>
					<div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
						<label className="block text-[13px] font-medium text-foreground" htmlFor="web-access-origin">
							{t("webAccess.originLabel")}
							<Input
								id="web-access-origin"
								className="mt-2"
								value={model.origin}
								placeholder={t("webAccess.originPlaceholder")}
								disabled={enabled || model.busy}
								onChange={(event) => model.setOrigin(event.target.value)}
							/>
						</label>
						<label className="block text-[13px] font-medium text-foreground" htmlFor="web-access-port">
							{t("webAccess.portLabel")}
							<Input
								id="web-access-port"
								className="mt-2"
								inputMode="numeric"
								value={model.port}
								disabled={enabled || model.busy}
								onChange={(event) => model.setPort(event.target.value)}
							/>
						</label>
					</div>
				</details>
				{enabled ? (
					<Button className="mt-4" variant="destructive" disabled={model.busy} onClick={() => void model.disable()}>
						{t("webAccess.disable")}
					</Button>
				) : null}
			</section>

			<section className="mb-6 rounded-xl border border-border/50 bg-card/40 p-4">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-[14px] font-semibold text-foreground">{t("webAccess.pairTitle")}</h2>
						<p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{t("webAccess.pairHint")}</p>
					</div>
					<Button variant="primary" disabled={model.busy || model.state.status === "starting" || (!enabled && !model.origin.trim())} onClick={() => void model.pair()}>
						{t("webAccess.pair")}
					</Button>
				</div>
				{model.pairing ? (
					<div className="mt-4 space-y-3 rounded-lg border border-primary/30 bg-primary/10 p-3">
						<div>
							<p className="text-[12px] font-medium text-foreground">{t("webAccess.webUrl")}</p>
							<code className="mt-1 block break-all text-[12px] text-muted-foreground">{model.pairing.webUrl}</code>
						</div>
						<div>
							<p className="text-[12px] font-medium text-foreground">{t("webAccess.code")}</p>
							<code className="mt-1 block break-all select-all text-[14px] text-primary">{model.pairing.code}</code>
						</div>
						<p className="text-[12px] text-muted-foreground">{t("webAccess.codeHint")}</p>
					</div>
				) : null}
			</section>

			<section className="rounded-xl border border-border/50 bg-card/40 p-4">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-[14px] font-semibold text-foreground">{t("webAccess.grantsTitle")}</h2>
						<p className="mt-1 text-[12px] text-muted-foreground">{t("webAccess.grantsHint")}</p>
					</div>
					{model.state.grants.length > 0 ? (
						<Button variant="destructive" size="sm" disabled={model.busy} onClick={() => void model.revoke()}>
							{t("webAccess.revokeAll")}
						</Button>
					) : null}
				</div>
				{model.state.grants.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-[12px] text-muted-foreground">{t("webAccess.noGrants")}</p>
				) : (
					<div className="space-y-2">
						{model.state.grants.map((grant) => (
							<div key={grant.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 px-3 py-2">
								<div className="min-w-0">
									<code className="block truncate text-[12px] text-muted-foreground">{grant.id}</code>
									<span className="text-[11px] text-muted-foreground/70">
										{t("webAccess.expiresAt", { time: new Date(grant.expiresAt).toLocaleString() })}
									</span>
								</div>
								<Button variant="outline" size="sm" disabled={model.busy} onClick={() => void model.revoke(grant.id)}>
									{t("webAccess.revoke")}
								</Button>
							</div>
						))}
					</div>
				)}
			</section>
			{model.error ? (
				<p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert">
					{model.error}
				</p>
			) : null}
		</div>
	);
}
