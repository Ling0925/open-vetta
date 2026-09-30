import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const desktop = resolve(fixture, "../../..");
const repo = resolve(desktop, "../..");
const packageSource = (name, path = "index.ts") => resolve(repo, `packages/${name}/src/${path}`);

export default defineConfig({
	root: fixture,
	publicDir: resolve(desktop, "src/renderer/public"),
	plugins: [react(), tailwindcss()],
	define: {
		"process.env.VETTA_CLOUD_ENABLED": JSON.stringify("false"),
		"process.env.VETTA_SHOW_UI_THEME": JSON.stringify("false"),
		"process.env.VETTA_SENTRY_ENABLED": JSON.stringify("false"),
	},
	resolve: {
		alias: [
			{ find: "@shared", replacement: resolve(desktop, "src/renderer/shared") },
			{ find: "@domains", replacement: resolve(desktop, "src/renderer/domains") },
			{ find: "@cloud", replacement: resolve(desktop, "src/renderer/cloud") },
			{ find: "@", replacement: resolve(desktop, "src") },
			{
				find: "@vetta/coding-agent/session-extensions",
				replacement: packageSource("coding-agent", "public-api/session-extensions.ts"),
			},
			{
				find: "@vetta/runtime-core/session-extensions",
				replacement: packageSource("runtime-core", "session-extensions/index.ts"),
			},
			{
				find: "@vetta/runtime-core/conversation",
				replacement: packageSource("runtime-core", "conversation/index.ts"),
			},
			{ find: "@vetta/ai/protocol", replacement: packageSource("ai", "protocol/index.ts") },
			{ find: "@vetta/ai/reasoning-presets", replacement: packageSource("ai", "reasoning-presets.ts") },
			{ find: "@vetta/ssh-transport/project-uri", replacement: packageSource("ssh-transport", "project-uri.ts") },
			{ find: "@vetta-org/theme-ui", replacement: resolve(repo, "packages/theme-ui/src") },
			{ find: "@vetta-org/theme-sdk", replacement: resolve(repo, "packages/theme-sdk/src") },
			{ find: "@vetta-org/ui", replacement: packageSource("ui") },
		],
	},
	server: { host: "127.0.0.1", port: 4173, strictPort: true, fs: { allow: [repo] } },
});
