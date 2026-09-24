/** Bound to one local top-level renderer, not webviews, subframes, remote browser clients or other windows. */
export function isCodexWorkspaceSender(actual: { owner: boolean; mainFrame: boolean; url: string }, expectedUrl: string): boolean {
	if (!actual.owner || !actual.mainFrame) return false;
	try {
		const incoming = new URL(actual.url); const expected = new URL(expectedUrl);
		incoming.hash = ""; expected.hash = "";
		if (!["file:", "http:", "https:"].includes(expected.protocol)) return false;
		return incoming.href === expected.href;
	} catch { return false; }
}

/** Electron's current details object, with the older positional contract retained for the installed version. */
export function replacesMainDocument(details: unknown, legacyInPlace?: boolean, legacyMainFrame?: boolean): boolean {
	if (details && typeof details === "object" && "isSameDocument" in details && "isMainFrame" in details) {
		return details.isMainFrame === true && details.isSameDocument === false;
	}
	return legacyMainFrame === true && legacyInPlace === false;
}
