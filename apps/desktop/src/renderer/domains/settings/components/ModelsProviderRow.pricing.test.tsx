// @vitest-environment jsdom
import type { ModelsConfigData } from "@preload/api.js";
import { localModelsConfigAtom } from "@shared/store/model-catalog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { ModelsProviderRow } from "./ModelsProviderRow";
import { useModelsSettingsModel } from "./useModelsSettingsModel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./recordSettingsUsage", () => ({ recordSettingsUsage: vi.fn() }));

function TestProvider(): JSX.Element {
	return <ModelsProviderRow name="custom" model={useModelsSettingsModel()} />;
}

describe("custom model pricing", () => {
	it("adds four USD rates, persists them, and preserves them while editing the model", async () => {
		const user = userEvent.setup();
		let config: ModelsConfigData = {
			providers: { custom: { baseUrl: "https://example.test/v1", api: "openai-completions", models: [] } },
		};
		(window as unknown as { vetta: unknown }).vetta = {
			models: {
				get: async () => config,
				set: async (next: ModelsConfigData) => { config = next; },
			},
		};
		getDefaultStore().set(localModelsConfigAtom, config);
		render(<TestProvider />);

		await user.click(screen.getByRole("button", { name: /custom/ }));
		await user.click(screen.getByRole("button", { name: "addModel" }));
		await user.type(screen.getByPlaceholderText("modelIdPlaceholder"), "my-model");
		await user.type(screen.getByRole("textbox", { name: "costInput" }), "1.25");
		await user.type(screen.getByRole("textbox", { name: "costOutput" }), "8");
		await user.type(screen.getByRole("textbox", { name: "costCacheRead" }), "0.125");
		expect(screen.getByRole("button", { name: "add" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("modelPriceInvalid")).toBeTruthy();
		await user.type(screen.getByRole("textbox", { name: "costCacheWrite" }), "2");
		await user.click(screen.getByRole("button", { name: "add" }));
		await waitFor(() => expect(config.providers.custom?.models?.[0]?.cost).toEqual({
			input: 1.25, output: 8, cacheRead: 0.125, cacheWrite: 2,
		}));

		await user.click(screen.getByTitle("editModel"));
		expect((screen.getByRole("textbox", { name: "costInput" }) as HTMLInputElement).value).toBe("1.25");
		fireEvent.change(screen.getByPlaceholderText("optional"), { target: { value: "Renamed model" } });
		await user.click(screen.getByRole("button", { name: "save" }));
		await waitFor(() => expect(config.providers.custom?.models?.[0]).toMatchObject({
			id: "my-model", name: "Renamed model", cost: { input: 1.25, output: 8, cacheRead: 0.125, cacheWrite: 2 },
		}));
	});
});
