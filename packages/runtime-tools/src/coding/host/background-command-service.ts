export type BackgroundCommandStatus = "running" | "completed" | "failed" | "killed";
export type BackgroundCommandStopReason = "caller" | "agent" | "dispose" | "timeout" | "output-limit";

export interface BackgroundCommandSnapshot {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly status: BackgroundCommandStatus;
	readonly outputFile: string;
	readonly exitCode: number | undefined;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly toolCallId?: string;
	readonly tail: string;
	readonly endedBy?: BackgroundCommandStopReason;
	readonly failureReason?: string;
}

export type BackgroundCommandEvent =
	| { readonly type: "task_started"; readonly task: BackgroundCommandSnapshot }
	| { readonly type: "task_output"; readonly task: BackgroundCommandSnapshot }
	| { readonly type: "task_ended"; readonly task: BackgroundCommandSnapshot }
	| { readonly type: "tasks_cleared" };

export interface SpawnBackgroundCommandOptions {
	readonly command: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly toolCallId?: string;
	readonly notifyOnlyIfPromoted?: boolean;
	/** Keep pipe stdin open. This is not a PTY and never falls back to a different host. */
	readonly interactive?: boolean;
	readonly timeoutMs?: number;
}

export interface ReadBackgroundCommandOutputOptions {
	readonly fromStart: boolean;
	readonly advanceCursor: boolean;
	/** Bounded read; the cursor advances only over returned bytes. */
	readonly maxBytes?: number;
}

export interface WriteBackgroundCommandInputOptions {
	readonly text: string;
	readonly close?: boolean;
	readonly signal?: AbortSignal;
}

export interface BackgroundCommandService {
	readonly supportsInteractiveInput?: boolean;
	/** Write to a session-owned interactive pipe, optionally sending EOF. */
	writeInput?(taskId: string, options: WriteBackgroundCommandInputOptions): Promise<void>;
	spawn(options: SpawnBackgroundCommandOptions): BackgroundCommandSnapshot;
	subscribe(listener: (event: BackgroundCommandEvent) => void): () => void;
	subscribeNotifications(listener: (task: BackgroundCommandSnapshot) => void): () => void;
	wait(
		taskId: string,
		options: { readonly maxMs: number; readonly signal?: AbortSignal },
	): Promise<{ readonly stillRunning: boolean; readonly snapshot: BackgroundCommandSnapshot }>;
	get(taskId: string): BackgroundCommandSnapshot | undefined;
	list(): readonly BackgroundCommandSnapshot[];
	clearFinished(): number;
	readOutput(taskId: string, options: ReadBackgroundCommandOutputOptions): string;
	stop(taskId: string, reason?: BackgroundCommandStopReason): boolean;
	dispose(): void;
	shutdown(): Promise<void>;
}
