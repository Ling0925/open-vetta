// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it } from "vitest";
import { RuntimeBackendSelector } from "./RuntimeBackendSelector";
import type { RuntimeBackendSelectorModel } from "../../hooks/useRuntimeBackendModel";

describe("original input toolbar runtime control", () => {
	it("renders both backends in place, waits for confirmed state and blocks changes while busy", async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
		const selected: string[] = [];
		const model: RuntimeBackendSelectorModel = { backend: "native", disabled: false, label: "Runtime backend", help: "Keep this conversation", retryLabel: "Retry", select: value => selected.push(value), retry() {} };
		try {
			await act(async () => root.render(<RuntimeBackendSelector model={model} />));
			const buttons = element.querySelectorAll<HTMLButtonElement>("button");
			assert.equal(buttons.length, 2); assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
			await act(async () => buttons[1].click()); assert.deepEqual(selected, ["codex"]);
			assert.equal(buttons[0].getAttribute("aria-pressed"), "true", "No optimistic backend impersonation");
			await act(async () => root.render(<RuntimeBackendSelector model={{ ...model, backend: "codex", disabled: true }} />));
			assert.equal(buttons[1].getAttribute("aria-pressed"), "true");
			await act(async () => buttons[0].click()); assert.deepEqual(selected, ["codex"]);
			assert.equal(element.querySelector("textarea"), null); assert.equal(element.querySelector("a"), null);
		} finally { await act(async () => root.unmount()); element.remove(); }
	});
});
