// @vitest-environment jsdom
import type { ToolCallBlock } from "@shared/store/atoms";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ToolCallBlockView } from "./ToolCallBlock";
import { extractToolUiDetails } from "../../services/chat-service";

afterEach(cleanup);

function Wrapper({ children }: { children: ReactNode }) {
	return <Provider store={createStore()}>{children}</Provider>;
}

function writeBlock(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
	return {
		type: "tool_call",
		toolCallId: "write-1",
		toolName: "write",
		args: { path: "src/example.ts", content: "new implementation" },
		status: "success",
		result: "Successfully wrote file",
		uiDetails: extractToolUiDetails(undefined, {
			diff: "-1 old implementation\n+1 new implementation",
			firstChangedLine: 1,
		}),
		...overrides,
	};
}

describe("write result review", () => {
	it("can review a restored diff when the original full-content arguments were omitted", async () => {
		render(<ToolCallBlockView block={writeBlock({ args: { path: "src/example.ts" }, result: undefined })} />, {
			wrapper: Wrapper,
		});
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("1 old implementation")).toBeTruthy();
	});

	it("changes an open pending content preview into the confirmed diff after completion", async () => {
		const { rerender } = render(<ToolCallBlockView block={writeBlock({ status: "pending" })} />, {
			wrapper: Wrapper,
		});
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("new implementation")).toBeTruthy();
		rerender(<ToolCallBlockView block={writeBlock()} />);
		expect(screen.getByText("1 old implementation")).toBeTruthy();
		expect(screen.queryByText("new implementation")).toBeNull();
	});

	it("opens a completed write as the same before/after diff used for edits", async () => {
		render(<ToolCallBlockView block={writeBlock()} />, { wrapper: Wrapper });
		const trigger = screen.getByRole("button");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await userEvent.click(trigger);
		expect(screen.getByText("1 old implementation")).toBeTruthy();
		expect(screen.getByText("1 new implementation")).toBeTruthy();
		expect(screen.queryByText("new implementation")).toBeNull();
		await userEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it.each([
		{ status: "pending" as const },
		{ status: "error" as const, isError: true, result: "Permission denied" },
		{ uiDetails: undefined },
		{ uiDetails: { diff: "" } },
	])("keeps content preview when no completed, successful diff is available: %j", async (overrides) => {
		render(<ToolCallBlockView block={writeBlock(overrides)} />, { wrapper: Wrapper });
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("new implementation")).toBeTruthy();
		expect(screen.queryByText("1 old implementation")).toBeNull();
		if ("isError" in overrides && overrides.isError) expect(screen.getByText("Permission denied")).toBeTruthy();
	});
});
