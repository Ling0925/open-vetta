import type { HistoryEntry } from "@vetta/runtime-core";

export const historyRequests: Array<{ sessionId: string; resolve: (history: HistoryEntry[]) => void }> = [];

export function installFixturePreload(): void {
	const noopSubscription = () => () => {};
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			i18n: { initialLanguage: "en", onLanguageChanged: noopSubscription },
			models: { get: async () => ({ providers: {} }), fetchRemote: async () => ({ providers: {} }) },
			skills: { list: async () => [] },
			abilities: { listOpenMarketplaces: async () => ({ abilities: [] }) },
			config: { get: async () => ({ experimental: { promptPrediction: false } }) },
			session: {
				getFullHistory: (sessionId: string) =>
					new Promise<HistoryEntry[]>((resolve) => historyRequests.push({ sessionId, resolve })),
				nextPromptSuggestions: async () => [],
			},
			clipboard: { writeText: async () => {} },
		},
	});
}
