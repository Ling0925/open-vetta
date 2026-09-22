// @vitest-environment jsdom

import type { ModelsConfigData } from "@preload/api";
import common from "@/shared/i18n/locales/en/common.json";
import { DetailDrawer } from "@vetta-org/theme-ui/overlays";
import { Button } from "@vetta-org/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { getDefaultStore } from "jotai";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localModelsConfigAtom, remoteProvidersAtom } from "@shared/store/atoms";
import { modelCatalog } from "@shared/store/model-catalog";
import { ModelSelect } from "./ModelSelect";

const catalog: ModelsConfigData = {
	providers: {
		fixture: {
			api: "openai-responses",
			baseUrl: "https://models.invalid",
			models: [
				{ id: "alpha", name: "Alpha", reasoning: true, reasoningLevels: ["low", "high"], defaultReasoningLevel: "low" },
				{ id: "beta", name: "Beta", reasoning: true, reasoningLevels: ["low", "high"], defaultReasoningLevel: "low" },
			],
		},
	},
};

const i18n = createInstance();
await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { common } }, interpolation: { escapeValue: false } });

function AgentConfigurationFixture({ showDrawer = true }: { showDrawer?: boolean }) {
	const [open, setOpen] = useState(false);
	const [model, setModel] = useState<string | null>("fixture/alpha");
	const [reasoning, setReasoning] = useState("low");
	const [clicks, setClicks] = useState(0);
	return (
		<I18nextProvider i18n={i18n}>
			<Button onClick={() => setOpen(true)}>Configure Agent</Button>
			<Button onClick={() => setClicks((value) => value + 1)}>Main action {clicks}</Button>
			{showDrawer ? (
				<DetailDrawer open={open} title="Agent configuration" onClose={() => setOpen(false)}>
					<ModelSelect value={model} onChange={setModel} reasoning={{ value: reasoning, onChange: setReasoning }} />
					<Button onClick={() => setOpen(false)}>Close configuration</Button>
				</DetailDrawer>
			) : null}
		</I18nextProvider>
	);
}

class FixturePointerEvent extends MouseEvent {
	readonly pointerType: string;
	readonly pointerId: number;
	constructor(type: string, options: PointerEventInit = {}) {
		super(type, options);
		this.pointerType = options.pointerType ?? "mouse";
		this.pointerId = options.pointerId ?? 1;
	}
}

const pointerMethods = ["scrollIntoView", "hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const;
let originalDescriptors: Array<PropertyDescriptor | undefined> = [];

beforeEach(() => {
	originalDescriptors = pointerMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
	vi.stubGlobal("PointerEvent", FixturePointerEvent);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
	vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
	vi.stubGlobal("vetta", { models: { get: vi.fn().mockResolvedValue(catalog), fetchRemote: vi.fn().mockResolvedValue({ providers: {} }) } });
	vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 300, 40));
	const getComputedStyle = window.getComputedStyle.bind(window);
	vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
		const style = getComputedStyle(element, pseudoElement);
		if (!style.transform) Object.defineProperty(style, "transform", { configurable: true, value: "none" });
		return style;
	});
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
	Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
	Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
	Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
	// Bound a regression's recursive focus feedback instead of overflowing the test worker.
	const focus = HTMLElement.prototype.focus;
	let focusCalls = 0;
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
		if (++focusCalls > 100) throw new Error("Nested overlays repeatedly stole focus from each other");
		focus.call(this, options);
	});
	modelCatalog.reset();
	getDefaultStore().set(localModelsConfigAtom, catalog);
	getDefaultStore().set(remoteProvidersAtom, {});
});

afterEach(() => {
	cleanup();
	modelCatalog.reset();
	getDefaultStore().set(localModelsConfigAtom, null);
	getDefaultStore().set(remoteProvidersAtom, {});
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const [index, name] of pointerMethods.entries()) {
		const descriptor = originalDescriptors[index];
		if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
		else Reflect.deleteProperty(HTMLElement.prototype, name);
	}
	document.body.style.pointerEvents = "";
});

async function selectModelThenReopen(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Configure Agent" }));
	await user.click(screen.getByRole("button", { name: /Alpha/ }));
	await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("searchbox")));
	await user.click(screen.getByRole("menuitem", { name: "Beta" }));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	const trigger = screen.getByRole("button", { name: /Beta/ });
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	await user.click(trigger);
	await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("searchbox")));
}

describe("Agent drawer model and reasoning selection", () => {
	it("selects a model, reopens the menu, selects reasoning and returns to a clickable main screen", async () => {
		const user = userEvent.setup();
		render(<AgentConfigurationFixture />);
		await selectModelThenReopen(user);
		const reasoning = screen.getByRole("menuitem", { name: /Reasoning/ });
		act(() => reasoning.focus());
		await user.keyboard("{ArrowRight}");
		await user.click(await screen.findByRole("menuitem", { name: "High" }));
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(screen.getByRole("button", { name: /Beta.*High/ })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Close configuration" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.body.style.pointerEvents).not.toBe("none");
		await user.click(screen.getByRole("button", { name: "Main action 0" }));
		expect(screen.getByRole("button", { name: "Main action 1" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Configure Agent" }));
		expect(screen.getByRole("button", { name: /Beta.*High/ })).toBeTruthy();
	});

	it("releases the page interaction lock when a drawer is removed with its reasoning menu open", async () => {
		const user = userEvent.setup();
		const view = render(<AgentConfigurationFixture />);
		await selectModelThenReopen(user);
		await user.hover(screen.getByRole("menuitem", { name: /Reasoning/ }));
		expect(await screen.findByRole("menuitem", { name: "High" })).toBeTruthy();
		view.rerender(<AgentConfigurationFixture showDrawer={false} />);
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.body.style.pointerEvents).not.toBe("none");
		await user.click(screen.getByRole("button", { name: "Main action 0" }));
		expect(screen.getByRole("button", { name: "Main action 1" })).toBeTruthy();
	});
});
