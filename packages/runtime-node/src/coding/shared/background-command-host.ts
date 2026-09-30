export interface BackgroundCommandProcess {
	stop(): void;
	writeInput?(text: string, close: boolean, signal?: AbortSignal): Promise<void>;
}

export interface SpawnBackgroundCommandProcessOptions {
	readonly command: string;
	readonly interactive?: boolean;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly onOutput: (text: string) => void;
	readonly onExit: (exitCode: number | undefined) => void;
	readonly onError: (error: Error) => void;
}

export interface BackgroundCommandProcessOperations {
	readonly supportsInteractiveInput?: boolean;
	spawn(options: SpawnBackgroundCommandProcessOptions): BackgroundCommandProcess;
}

export interface BackgroundCommandOutput {
	readonly path: string;
	append(text: string): void;
	read(offset: number, maxBytes?: number): string;
	close(): void;
}

export interface BackgroundCommandOutputStore {
	create(taskId: string): BackgroundCommandOutput;
}

export interface BackgroundCommandHost {
	readonly processOperations: BackgroundCommandProcessOperations;
	readonly outputStore: BackgroundCommandOutputStore;
}
