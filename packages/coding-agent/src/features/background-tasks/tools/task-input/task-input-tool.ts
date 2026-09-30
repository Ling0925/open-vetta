import { type Static, Type } from "@sinclair/typebox";
import type { RuntimeToolDefinition } from "@vetta/runtime-core/kernel";
import type { BackgroundCommandService } from "@vetta/runtime-tools";
import { createTaskOutputTool } from "../task-output/task-output-tool.js";

export const TaskInputToolInputSchema = Type.Object({
	description: Type.Optional(
		Type.String({ description: "Brief user-facing reason for this tool call (max 100 chars).", maxLength: 100 }),
	),
	task_id: Type.String({ description: "Exact task ID returned by an interactive bash/shell call in this session." }),
	input: Type.Optional(
		Type.String({
			description:
				"Text to write verbatim to stdin. Include a newline when needed. May execute new commands and requires the same authorization as command execution.",
			maxLength: 16384,
		}),
	),
	close_stdin: Type.Optional(
		Type.Boolean({
			description: "Send EOF after the text. Closing stdin is irreversible; repeated empty EOF is harmless.",
		}),
	),
	wait_ms: Type.Optional(
		Type.Integer({
			description:
				"Soft wait for command completion, then return bounded incremental output. Default 1000 ms; does not impose a process timeout.",
			minimum: 0,
			maximum: 10000,
		}),
	),
});
export type TaskInputToolInput = Static<typeof TaskInputToolInputSchema>;

export interface TaskInputToolOptions {
	readonly backgroundService: BackgroundCommandService;
	/** Checked at execution time as well as catalog selection, including old generation leases. */
	readonly isInputAllowed?: () => boolean;
	readonly readSessionId?: () => string;
}

export function createTaskInputTool(options: TaskInputToolOptions): RuntimeToolDefinition<TaskInputToolInput> {
	const output = createTaskOutputTool(options);
	return {
		name: "task_input",
		label: "task_input",
		description:
			"Send text or EOF to a session-owned interactive command started with bash/shell interactive:true, then read incremental output. Input can execute new commands, so every call goes through tool authorization. Pipe transport only: no PTY, terminal keys, or resizing. Not available in sandbox, Plan mode, or on unsupported hosts. Cancellation after input execution starts terminates the task and waits for exit; cancelling pending authorization does not stop the existing task. Stale task IDs from another or restored session are invalid.",
		inputSchema: TaskInputToolInputSchema,
		async execute(request) {
			request.signal.throwIfAborted();
			if (options.isInputAllowed?.() === false)
				throw new Error("Interactive input is not allowed in the current execution mode.");
			if (options.readSessionId && request.sessionId !== options.readSessionId())
				throw new Error("Interactive task belongs to a different session.");
			if (!options.backgroundService.supportsInteractiveInput || !options.backgroundService.writeInput) {
				throw new Error("Interactive pipe input is not supported by this host.");
			}
			await options.backgroundService.writeInput(request.input.task_id, {
				text: request.input.input ?? "",
				close: request.input.close_stdin,
				signal: request.signal,
			});
			await options.backgroundService.wait(request.input.task_id, {
				maxMs: request.input.wait_ms ?? 1000,
				signal: request.signal,
			});
			return output.execute({ ...request, input: { task_id: request.input.task_id } });
		},
	};
}
