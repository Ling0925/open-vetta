export interface TodoItem {
	id: number;
	content: string;
	status: "pending" | "in_progress" | "done";
}

export type TodoPlanItem = Pick<TodoItem, "content" | "status">;
export type TodoPlanUpdate =
	| { readonly ok: true; readonly items: readonly TodoItem[] }
	| { readonly ok: false; readonly error: string };

export type TodoLockSource = "scene";

export interface TodoSnapshotEnvelope {
	items: TodoItem[];
	lockedBy: TodoLockSource | null;
}

export type TodoSnapshot = TodoSnapshotEnvelope | TodoItem[];
export type TodoUpdateListener = (items: ReadonlyArray<TodoItem>) => void;

export interface TodoContinuationState {
	getAll(): ReadonlyArray<TodoItem>;
	isLocked(): boolean;
}

export interface SceneTodoState {
	readSceneTodoState(): { readonly locked: boolean; readonly itemCount: number };
	initializeSceneTodoItems(contents: readonly string[]): void;
}

export interface CodingAgentTodoRuntime extends RuntimeDocumentParticipant {
	getAll(): ReadonlyArray<TodoItem>;
	readItems(): readonly TodoItem[];
	isLocked(): boolean;
	getLockSource(): TodoLockSource | null;
	createMany(contents: string[]): TodoItem[];
	update(id: number, status: TodoItem["status"]): TodoItem | undefined;
	replacePlan(plan: readonly TodoPlanItem[]): TodoPlanUpdate;
	clear(): boolean;
	/** 订阅 Todo 变更，供宿主把状态实时广播给 UI。返回退订函数。 */
	subscribe(listener: TodoUpdateListener): () => void;
	initializeTodoItems(contents: readonly string[], lockSource?: TodoLockSource): void;
	readSceneTodoState(): { readonly locked: boolean; readonly itemCount: number };
	initializeSceneTodoItems(contents: readonly string[]): void;
	flush(): Promise<void>;
	dispose(): Promise<void>;
}

import type { RuntimeDocumentParticipant } from "@vetta/runtime-core";
