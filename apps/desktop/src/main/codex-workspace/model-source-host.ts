import { resolveProviderFetch, type Model } from "@vetta/ai";
import type { CodexGatewaySource } from "@vetta/runtime-node/codex-app-server";
import { resolveNodeConfigurationValue } from "@vetta/runtime-node/host";
import { getDesktopModelSettingsService, onDesktopModelSettingsChanged } from "../models/model-settings-host.js";
import { listCodexModelChoices, modelKeyParts, resolveCodexModel } from "./model-source.js";

export async function listDesktopCodexModels() {
	// Renderer gets explicit display fields only, never credentialRef, headers or the resolved config.
	return listCodexModelChoices(await getDesktopModelSettingsService().getRendererConfig());
}

export function createDesktopCodexModelSource(modelKey: string): CodexGatewaySource {
	const [provider, modelId] = modelKeyParts(modelKey);
	return {
		resolve: async () => resolveCodexModel(await getDesktopModelSettingsService().getConfig(), modelKey,
			value => resolveNodeConfigurationValue(value)),
		subscribe: invalidate => onDesktopModelSettingsChanged(ids => { if (ids.includes(provider)) invalidate(); }),
		fetch: (input, init) => {
			// Reuse Vetta's live provider proxy/direct resolver, not Codex's inherited HTTP_PROXY environment.
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const routing: Model<"openai-responses"> = {
				id: modelId, name: modelId, api: "openai-responses", provider, baseUrl: url,
				reasoning: false, input: ["text"], contextWindow: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			// Numeric fields above are required for the routing descriptor, not usage measurements.
			return (resolveProviderFetch(routing) ?? globalThis.fetch)(input, init);
		},
	};
}
