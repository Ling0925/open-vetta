import type { ConversationScenario } from "../../../../profiles/index.js";
import type { CodingAgentRuntimeToolRegistration } from "../../../../runtime-contracts/index.js";
import {
	createAskAdvisorTool,
	type AskAdvisorToolInput,
	type AskAdvisorToolOptions,
} from "./ask-advisor-tool.js";

export const ASK_ADVISOR_TOOL_SCOPES = [
	"conversation",
	"project",
	"cli",
] as const satisfies readonly ConversationScenario[];
export const ASK_ADVISOR_TOOL_CATEGORY = "agent-control" as const;

export interface AskAdvisorToolRegistrationOptions extends AskAdvisorToolOptions {
	readonly modelOrder?: number;
}

export function createAskAdvisorToolRegistration(
	options: AskAdvisorToolRegistrationOptions,
): CodingAgentRuntimeToolRegistration<AskAdvisorToolInput> {
	return {
		tool: { ...createAskAdvisorTool(options), modelOrder: options.modelOrder },
		scopeUse: ASK_ADVISOR_TOOL_SCOPES,
		modelOrder: options.modelOrder,
		category: ASK_ADVISOR_TOOL_CATEGORY,
	};
}
