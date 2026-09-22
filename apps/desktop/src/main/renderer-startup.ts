export interface RendererStartupOptions<T> {
	resetDevelopmentCache?: () => Promise<void>;
	startRenderer: () => T;
}

/**
 * Keep development cache invalidation ahead of every renderer network request.
 * Electron's session.clearCache() can interrupt in-flight Chromium requests,
 * which leaves the Vite module graph incomplete with ERR_NETWORK_CHANGED.
 */
export async function startRendererAfterSessionPreparation<T>(options: RendererStartupOptions<T>): Promise<T> {
	await options.resetDevelopmentCache?.();
	return options.startRenderer();
}

export interface RuntimeDependentStartupOptions {
	readonly visibleShell: Promise<unknown>;
	readonly prepareEnvironment: () => Promise<void>;
	readonly prepareImHost: () => void;
}

/** Keep the boot shell visible while preparing PATH/runtime state, then load IM state before business IPC opens. */
export async function prepareRuntimeDependentStartup(options: RuntimeDependentStartupOptions): Promise<void> {
	await options.visibleShell;
	await options.prepareEnvironment();
	options.prepareImHost();
}
