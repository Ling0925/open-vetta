/** Installed artifact boundary: the existing conversation toolbar, not a separate runtime page. */
const installedCodex = process.env.VETTA_CODEX_PREVIEW_REQUIRED === "1" ? describe : describe.skip;
installedCodex("installed conversation runtime switch", () => {
	it("switches the new-conversation backend in place without exposing executable setup fields", async () => {
		await browser.waitUntil(async () => {
			for (const handle of await browser.getWindowHandles()) {
				await browser.switchToWindow(handle);
				if ((await browser.getUrl()).includes("renderer/index.html")) return true;
			}
			return false;
		}, { timeout: 60000, timeoutMsg: "Main renderer did not start" });
		await browser.execute(() => { window.location.hash = "/new-session"; });
		const codex = await $("button=Codex");
		const native = await $("button=Native");
		await codex.waitForDisplayed({ timeout: 60000 });
		await codex.waitForEnabled({ timeout: 60000 });
		expect(await native.getAttribute("aria-pressed")).toBe("true");
		const originalUrl = await browser.getUrl();
		// Packaged CI can briefly draw a progress indicator over the toolbar. The contract
		// under test is the in-place toggle wiring, not pointer hit-testing through that overlay.
		await browser.execute((element) => (element as HTMLElement).click(), codex);
		await browser.waitUntil(async () => (await codex.getAttribute("aria-pressed")) === "true", { timeout: 15000 });
		expect(await browser.getUrl()).toBe(originalUrl);
		expect(await $("#codex-executable").isExisting()).toBe(false);
		expect(await $("#codex-codexHome").isExisting()).toBe(false);
		expect(await $("#codex-prompt").isExisting()).toBe(false);
		await browser.execute((element) => (element as HTMLElement).click(), native);
		await browser.waitUntil(async () => (await native.getAttribute("aria-pressed")) === "true", { timeout: 15000 });
		expect(await browser.getUrl()).toBe(originalUrl);
		const installed = await browser.electron.execute(electron => ({
			packaged: electron.app.isPackaged,
			home: process.env.VETTA_HOME,
			testMode: process.env.VETTA_E2E,
		}));
		expect(installed.packaged).toBe(true);
		expect(installed.testMode).toBe("1");
		expect(installed.home).toBeTruthy();
	});
});
