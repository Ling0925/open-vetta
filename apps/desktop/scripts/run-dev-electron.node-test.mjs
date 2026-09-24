import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { resolveDevLaunchEnvironment, resolveDevProcessEnvironment } from "./run-dev-electron.mjs";

test("ordinary development uses installed-app data and requires action approval", () => {
	const layout = resolveDevLaunchEnvironment({}, "/test-home");
	assert.deepEqual(layout, {
		configDir: ".vetta",
		userDataDir: join("/test-home", ".vetta", "electron-user-data"),
	});
	assert.equal(resolveDevProcessEnvironment({}, layout.configDir).VETTA_DEV_AUTO_APPROVE_ACTIONS, "0");
});

test("isolated development keeps its own data and local action approval bypass", () => {
	const environment = { VETTA_CONFIG_DIR: ".vetta-dev" };
	const layout = resolveDevLaunchEnvironment(environment, "/test-home");
	assert.deepEqual(layout, {
		configDir: ".vetta-dev",
		userDataDir: join("/test-home", ".vetta-dev", "electron-user-data"),
	});
	assert.equal(resolveDevProcessEnvironment(environment, layout.configDir).VETTA_DEV_AUTO_APPROVE_ACTIONS, "1");
});

test("UI verification stays isolated and explicit overrides remain available", () => {
	assert.equal(
		resolveDevLaunchEnvironment({ VETTA_UI_VERIFICATION: "1" }, "/test-home").configDir,
		".vetta-ui-verify",
	);
	assert.equal(
		resolveDevLaunchEnvironment(
			{ VETTA_CONFIG_DIR: ".vetta-dev", VETTA_DESKTOP_USER_DATA_DIR: "/other-profile" },
			"/test-home",
		).userDataDir,
		resolve("/other-profile"),
	);
	assert.equal(
		resolveDevProcessEnvironment({ VETTA_DEV_AUTO_APPROVE_ACTIONS: "1" }, ".vetta")
			.VETTA_DEV_AUTO_APPROVE_ACTIONS,
		"1",
	);
	assert.equal(
		resolveDevProcessEnvironment({ VETTA_DEV_AUTO_APPROVE_ACTIONS: "0" }, ".vetta-dev")
			.VETTA_DEV_AUTO_APPROVE_ACTIONS,
		"0",
	);
});
