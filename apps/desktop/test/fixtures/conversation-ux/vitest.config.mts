import { defineConfig } from "vitest/config";
import desktopConfig from "../../../vitest.config";

export default defineConfig({
	...desktopConfig,
	test: {
		...desktopConfig.test,
		include: ["test/fixtures/conversation-ux/*.test.tsx"],
		environment: "jsdom",
	},
});
