/** Installed artifact boundary: actual Electron/preload/UI and native Codex, without a model account. */
const preview = process.env.VETTA_CODEX_PREVIEW_REQUIRED === "1" ? describe : describe.skip;
preview("installed Codex preview first use", () => {
	it("opens the real preview page with bundled paths and no implicit saved configuration", async () => {
		await browser.waitUntil(
			async () => {
				for (const handle of await browser.getWindowHandles()) {
					await browser.switchToWindow(handle);
					if ((await browser.getUrl()).includes("renderer/index.html")) return true;
				}
				return false;
			},
			{ timeout: 60000, timeoutMsg: "Main renderer did not start" },
		);
		await browser.execute(() => {
			window.location.hash = "/new-session?target=runtime%3Acodex";
		});
		await $("#codex-executable").waitForDisplayed({ timeout: 60000 });
		expect(await $("#codex-executable").getValue()).toContain("codex-runtime");
		expect(await $("#codex-expectedVersion").getValue()).toBe("0.157.0");
		expect((await $("#codex-codexHome").getValue()).replaceAll("\\", "/")).toContain(
			"desktop-app/codex-runtime/home",
		);
		expect(await $("#codex-model-source").getText()).toMatch(/Vetta/);
		expect(await $("#codex-model").isExisting()).toBe(false);
		const installed = await browser.electron.execute((electron) => ({
			packaged: electron.app.isPackaged,
			resources: process.resourcesPath,
			home: process.env.VETTA_HOME,
			testMode: process.env.VETTA_E2E,
		}));
		expect(installed.packaged).toBe(true);
		expect(installed.testMode).toBe("1");
		expect(installed.home).toBeTruthy();
		expect((await $("#codex-executable").getValue()).replaceAll("\\", "/")).toContain(
			installed.resources.replaceAll("\\", "/"),
		);
		expect((await $("#codex-codexHome").getValue()).replaceAll("\\", "/")).toContain(
			(installed.home ?? "").replaceAll("\\", "/"),
		);
		let foundCreate = false;
		for (const button of await $$("button")) {
			if (/^(New Codex session|新建 Codex 会话)$/.test(await button.getText())) {
				foundCreate = true;
				expect(await button.isEnabled()).toBe(false);
			}
		}
		expect(foundCreate).toBe(true);

		// Returning to Native uses normal routing; neither entry silently changes the saved runtime.
		await browser.execute(() => {
			window.location.hash = "/new-session";
		});
		await $("#codex-executable").waitForExist({ reverse: true, timeout: 15000 });
	});
});
