// @vitest-environment jsdom
import type { ToolCallBlock } from "@shared/store/atoms";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { ToolCallBlockView } from "./ToolCallBlock";

function Wrapper({ children }: { children: ReactNode }) {
	return <Provider store={createStore()}>{children}</Provider>;
}

describe("ToolCallBlock Work-mode label", () => {
	it("shows the model-authored call description instead of the technical tool name", () => {
		const block: ToolCallBlock = {
			type: "tool_call",
			toolCallId: "delegate-call",
			toolName: "team_delegate_task",
			args: { description: "委派开发工程师实现游戏" },
			status: "pending",
		};

		render(<ToolCallBlockView block={block} aliased />, { wrapper: Wrapper });

		expect(screen.getByText("委派开发工程师实现游戏")).toBeTruthy();
		expect(screen.queryByText("team_delegate_task")).toBeNull();
	});
});


describe("ToolCallBlock running command output", () => {
	it("shows streamed output when a user opens an executing command", async () => {
		const user = userEvent.setup();
		const block: ToolCallBlock = {
			type: "tool_call",
			toolCallId: "command-1",
			toolName: "bash",
			args: { command: "long-running-command" },
			status: "pending",
			startedAt: 1,
			partialResult: "latest command output",
		};

		render(<ToolCallBlockView block={block} />, { wrapper: Wrapper });
		await user.click(screen.getByRole("button"));

		expect(await screen.findByText("latest command output")).toBeTruthy();
		expect(screen.getByText("正在执行···")).toBeTruthy();
	});
});
