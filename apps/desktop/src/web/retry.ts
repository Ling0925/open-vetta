const MAX_RETRY_DELAY_MS = 10_000;

export function retryDelay(attempt: number, initialDelayMs = 1_000): number {
	return Math.min(initialDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
