import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: path.resolve(__dirname, "src/web"),
	base: "./",
	plugins: [react(), tailwindcss()],
	publicDir: path.resolve(__dirname, "src/renderer/public"),
	resolve: {
		alias: {
			"@shared": path.resolve(__dirname, "src/renderer/shared"),
			"@vetta-org/theme-sdk": path.resolve(__dirname, "../../packages/theme-sdk/src"),
			"@vetta-org/theme-ui": path.resolve(__dirname, "../../packages/theme-ui/src"),
			"@vetta-org/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
		},
	},
	build: {
		outDir: path.resolve(__dirname, "dist/web"),
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			input: path.resolve(__dirname, "src/web/index.html"),
			output: {
				entryFileNames: "assets/web.js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
