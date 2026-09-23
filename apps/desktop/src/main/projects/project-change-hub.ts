import { randomUUID } from "node:crypto";

export type ProjectChangeListener = (cursor: number) => void;

export class ProjectChangeHub {
	private readonly generation: string;
	private cursorValue = 0;
	private readonly listeners = new Set<ProjectChangeListener>();

	constructor(generation = randomUUID()) {
		this.generation = generation;
	}

	getGeneration(): string {
		return this.generation;
	}

	getCursor(): number {
		return this.cursorValue;
	}

	subscribe(listener: ProjectChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	waitForChange(afterCursor: number, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
		if (this.cursorValue > afterCursor) return Promise.resolve(true);
		return new Promise<boolean>((resolve, reject) => {
			let settled = false;
			const unsubscribe = this.subscribe((cursor) => {
				if (cursor <= afterCursor || settled) return;
				settled = true;
				cleanup();
				resolve(true);
			});
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(false);
			}, timeoutMs);
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				const error = new Error("Project observation was aborted");
				error.name = "AbortError";
				reject(error);
			};
			const cleanup = (): void => {
				clearTimeout(timer);
				unsubscribe();
				signal.removeEventListener("abort", onAbort);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	notify(): number {
		this.cursorValue += 1;
		const cursor = this.cursorValue;
		for (const listener of [...this.listeners]) {
			try {
				listener(cursor);
			} catch {
				// One observer must not block local broadcasts or other observers.
			}
		}
		return cursor;
	}
}
