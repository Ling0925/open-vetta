import { type Static, Type } from "@sinclair/typebox";
import type { RuntimeToolDefinition } from "@vetta/runtime-core/kernel";
import type { SubagentCoordinatorPort, SubagentSnapshot } from "@vetta/runtime-subagents";
import { ToolCallDescriptionSchema } from "@vetta/runtime-tools/coding";
import { ASK_ADVISOR_TOOL_DESCRIPTION } from "./description.js";

export const AskAdvisorToolInputSchema = Type.Object({
	description: ToolCallDescriptionSchema,
	question: Type.String({
		minLength: 1,
		description: "The concrete decision, hypothesis, design, or answer the advisor should review.",
	}),
	focus: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Optional review emphasis, e.g. risks, alternatives, security, maintainability, or debugging.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: 5_000,
			maximum: 180_000,
			description: "How long to synchronously wait for the advisor. Default 90000 ms.",
		}),
	),
});

export type AskAdvisorToolInput = Static<typeof AskAdvisorToolInputSchema>;

export interface AskAdvisorToolOptions {
	readonly getCoordinator: () => SubagentCoordinatorPort | undefined;
	readonly advisorTypeId: string;
}

export function createAskAdvisorTool(options: AskAdvisorToolOptions): RuntimeToolDefinition<AskAdvisorToolInput> {
	let sequence = 0;
	return {
		name: "ask_advisor",
		label: "ask_advisor",
		description: ASK_ADVISOR_TOOL_DESCRIPTION,
		inputSchema: AskAdvisorToolInputSchema,
		async execute({ input, toolCallId }) {
			const coordinator = requireCoordinator(options);
			const taskName = nextAdvisorTaskName(coordinator, () => ++sequence);
			const title = advisorTitle(input.question);
			const snapshot = await coordinator.spawn({
				taskName,
				title,
				agentType: options.advisorTypeId,
				originToolCallId: toolCallId,
				message: advisorRequest(input.question, input.focus),
				deliveryMode: "terminal",
			});
			const result = await coordinator.wait({
				targets: [snapshot.id],
				timeoutMs: input.timeout_ms ?? 90_000,
			});
			const terminal = result.agents[0];
			if (!terminal) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Advisor ${snapshot.id} is still running in the background.`,
								`path: ${snapshot.path}`,
								"Do not spawn a duplicate consultation. Continue other work; the advisor result can arrive through the normal subagent notification path.",
							].join("\n"),
						},
					],
					details: { timedOut: true, advisor: snapshot },
				};
			}
			return {
				content: [{ type: "text", text: advisorResultText(terminal) }],
				details: { timedOut: false, advisor: terminal },
			};
		},
	};
}

function nextAdvisorTaskName(coordinator: SubagentCoordinatorPort, next: () => number): string {
	for (let attempts = 0; attempts < 10_000; attempts += 1) {
		const candidate = `advisor_${next()}`;
		if (!coordinator.get(candidate)) return candidate;
	}
	throw new Error("Unable to allocate an advisor task name");
}

function advisorTitle(question: string): string {
	const value = question.trim().replace(/\s+/gu, " ");
	return value.length <= 72 ? `Advisor · ${value}` : `Advisor · ${value.slice(0, 69)}…`;
}

function advisorRequest(question: string, focus: string | undefined): string {
	return [
		"<advisor_request>",
		"<question>",
		question.trim(),
		"</question>",
		...(focus?.trim() ? ["<focus>", focus.trim(), "</focus>"] : []),
		"</advisor_request>",
		"",
		"Return advice to the root agent only. Do not modify the workspace.",
	].join("\n");
}

function advisorResultText(snapshot: SubagentSnapshot): string {
	const header = `Advisor ${snapshot.id} (${snapshot.status})`;
	if (snapshot.status === "completed") {
		return [header, snapshot.finalText?.trim() || "Advisor completed without a text recommendation."].join("\n\n");
	}
	if (snapshot.status === "failed") {
		return [header, snapshot.errorMessage?.trim() || "Advisor failed without a diagnostic."].join("\n\n");
	}
	if (snapshot.status === "interrupted") {
		return [header, "Advisor consultation was interrupted."].join("\n\n");
	}
	return [header, "Advisor has not reached a terminal state."].join("\n\n");
}

function requireCoordinator(options: AskAdvisorToolOptions): SubagentCoordinatorPort {
	const coordinator = options.getCoordinator();
	if (!coordinator) throw new Error("Subagents are not enabled for this session.");
	return coordinator;
}
