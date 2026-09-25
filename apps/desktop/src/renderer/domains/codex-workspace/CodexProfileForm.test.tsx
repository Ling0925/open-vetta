// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, it } from "vitest";
import zh from "../../../shared/i18n/locales/zh/codex.json";
import type { CodexModelChoice, CodexWorkspaceProfile } from "../../../shared/codex-workspace";
import { CodexProfileForm } from "./CodexProfileForm";

let root: Root;
let container: HTMLDivElement;
let saved: CodexWorkspaceProfile[];
const language = i18next.createInstance();
const runtime = { executable: "/trusted/codex", expectedVersion: "1.0.0", codexHome: "/private/data", cwd: "/workspace", sandbox: "read-only" as const };
const models: CodexModelChoice[] = [{ modelKey: "gateway/local-alias", label: "My gateway / My model", baseUrl: "https://gateway.example/v1", isDefault: true }];
beforeEach(async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	await language.init({ initAsync: false, lng: "zh", fallbackLng: "zh", resources: { zh: { codex: zh } }, defaultNS: "codex" });
	saved = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(initial?: CodexWorkspaceProfile, status: "loading" | "ready" | "failed" = "ready") {
	await act(async () => root.render(<I18nextProvider i18n={language}><CodexProfileForm initial={initial} disabled={false}
		models={models} modelsStatus={status} choose={async () => undefined}
		save={async value => { saved.push(value); return { ok: true }; }} /></I18nextProvider>));
}
async function submit() {
	const form = container.querySelector("form"); assert.ok(form);
	await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
async function fill(field: string, value: string) {
	const input = container.querySelector<HTMLInputElement>(`#codex-${field}`); assert.ok(input);
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("reuse existing model configuration in the Codex form", () => {
	it("defaults new profiles to the configured Vetta default and saves only the reference", async () => {
		await render();
		for (const [field, value] of Object.entries(runtime)) if (field !== "sandbox") await fill(field, value);
		assert.equal(container.querySelector('input[type="password"]'), null);
		assert.equal(container.querySelector("#codex-model"), null);
		assert.match(container.textContent ?? "", /My gateway/);
		await submit();
		assert.deepEqual(saved, [{ ...runtime, vettaModelKey: "gateway/local-alias" }]);
		assert.equal(JSON.stringify(saved).includes("https://gateway.example"), false);
	});
	it("does not replace a missing saved reference with another available model", async () => {
		await render({ ...runtime, vettaModelKey: "deleted/model" });
		assert.ok(container.querySelector('[role="alert"]'));
		const button = container.querySelector<HTMLButtonElement>('button[type="submit"]'); assert.ok(button?.disabled);
		await submit(); assert.equal(saved.length, 0);
	});
	it("preserves the prior Codex-home profile and its model override until the user changes source", async () => {
		await render({ ...runtime, model: "legacy-model" });
		assert.equal(container.querySelector<HTMLInputElement>("#codex-model")?.value, "legacy-model");
		await submit(); assert.deepEqual(saved, [{ ...runtime, model: "legacy-model" }]);
	});
	it("keeps valid runtime fields after model loading fails and blocks an ambiguous save", async () => {
		await render({ ...runtime, vettaModelKey: "gateway/local-alias" }, "failed");
		assert.equal(container.querySelector<HTMLInputElement>("#codex-executable")?.value, runtime.executable);
		assert.ok(container.querySelector('[role="alert"]'));
		await submit(); assert.equal(saved.length, 0);
	});
});
