import {
	CatalogRoutedRuntimeHostSessionBackend,
	CompositeRuntimeSessionCatalog,
	type RuntimeHostSessionBackend,
	type RuntimeSessionAccessResolver,
	type RuntimeSessionCatalog,
} from "@vetta/runtime-core";
import { CodexRuntimeHostBackend } from "./host-backend.js";
import type { CodexHostBackendOptions } from "./host-contracts.js";
import { CodexRuntimeError } from "./types.js";

export interface CodexRuntimeHostIntegrationOptions extends CodexHostBackendOptions {
	readonly native: {
		readonly backend: RuntimeHostSessionBackend;
		readonly catalog: RuntimeSessionCatalog;
		readonly accessResolver: RuntimeSessionAccessResolver;
	};
	/** Explicitly affects new sessions only; existing paths always route to their recorded owner. */
	readonly defaultRuntime?: "native" | "codex";
}

/** Reuses RuntimeHost's existing catalog router. Native remains the default unless the host explicitly opts in. */
export function createCodexRuntimeHostIntegration(options: CodexRuntimeHostIntegrationOptions) {
	if (options.defaultRuntime !== undefined && options.defaultRuntime !== "native" && options.defaultRuntime !== "codex") {
		throw new CodexRuntimeError("CONFIGURATION", "Unknown runtime selection; refusing to fall back to Native");
	}
	const codexBackend = new CodexRuntimeHostBackend(options);
	const sessionBackend = new CatalogRoutedRuntimeHostSessionBackend({
		defaultBackend: options.defaultRuntime === "codex" ? codexBackend : options.native.backend,
		defaultRouteId: options.defaultRuntime ?? "native",
		routes: [{ id: "codex", catalog: codexBackend.catalog, backend: codexBackend },
			{ id: "native", catalog: options.native.catalog, backend: options.native.backend }],
		// The caller retains ownership of the injected Native backend.
		dispose: () => codexBackend.dispose(),
	});
	const sessionAccessResolver: RuntimeSessionAccessResolver = {
		resolve: async (path) => await codexBackend.catalog.ownsSession(path)
			? { readHistory: false, resume: true, rename: true, delete: false }
			: options.native.accessResolver.resolve(path),
	};
	return {
		codexBackend,
		sessionBackend,
		sessionCatalog: new CompositeRuntimeSessionCatalog([codexBackend.catalog, options.native.catalog]),
		sessionAccessResolver,
	};
}
