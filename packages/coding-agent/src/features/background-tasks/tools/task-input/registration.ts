import type { CodingAgentRuntimeToolRegistration } from "../../../../runtime-contracts/index.js";
import { TASK_OUTPUT_TOOL_REQUIRES, TASK_OUTPUT_TOOL_SCOPES } from "../task-output/registration.js";
import { createTaskInputTool, type TaskInputToolInput, type TaskInputToolOptions } from "./task-input-tool.js";

export function createTaskInputToolRegistration(
	options: TaskInputToolOptions,
): CodingAgentRuntimeToolRegistration<TaskInputToolInput> {
	return {
		tool: createTaskInputTool(options),
		scopeUse: TASK_OUTPUT_TOOL_SCOPES,
		requires: TASK_OUTPUT_TOOL_REQUIRES,
		category: "core",
	};
}
