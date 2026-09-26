// @vitest-environment jsdom

import type { ToolCallBlock } from "@shared/store/atoms";
import { describe, expect, it } from "vitest";
import {
	getCodexMcpInfo,
	getShellCommand,
	getShellCwd,
	getShellExitCode,
	toolCallDurationMs,
	toolCallIconColorClass,
	toolIcon,
	toolLabel,
} from "./parse-tool";

function block(toolName: string, args: Record<string, unknown>): ToolCallBlock {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		args,
		status: "success",
	};
}

describe("toolCallIconColorClass", () => {
	it("paints success green and keeps pending muted", () => {
		expect(toolCallIconColorClass("success")).toBe("text-emerald-400");
		expect(toolCallIconColorClass("pending")).toBe("text-muted-foreground/50");
	});

	it("paints the icon when the call failed", () => {
		expect(toolCallIconColorClass("error")).toBe("text-destructive/70");
		expect(toolCallIconColorClass("success", true)).toBe("text-destructive/70");
	});
});

describe("toolCallDurationMs", () => {
	it("shows the live elapsed ticker while pending", () => {
		expect(toolCallDurationMs("pending", undefined, 0)).toBe(0);
		expect(toolCallDurationMs("pending", undefined, 1500)).toBe(1500);
		expect(toolCallDurationMs("pending", 5000, null)).toBeNull();
	});

	it("shows the recorded duration for completed calls, including sub-second", () => {
		expect(toolCallDurationMs("success", 12, null)).toBe(12);
		expect(toolCallDurationMs("success", 1200, null)).toBe(1200);
		expect(toolCallDurationMs("error", 2400, null)).toBe(2400);
		expect(toolCallDurationMs("success", undefined, null)).toBeNull();
	});
});

describe("toolLabel", () => {
	it("uses the model-authored call description as the Work-mode primary label", () => {
		expect(
			toolLabel(
				block("read", {
					description: "核对团队会话的展示逻辑",
					path: "C:/workspace/teamChatModel.ts",
				}),
				true,
			),
		).toEqual({
			name: "核对团队会话的展示逻辑",
			detail: "C:/workspace/teamChatModel.ts",
		});
	});

	it("keeps the technical name primary outside Work mode", () => {
		expect(toolLabel(block("custom_tool", { description: "执行自定义操作" }))).toEqual({
			name: "custom_tool",
			detail: "执行自定义操作",
		});
	});

	it("renders Codex command execution as a shell command with readable detail", () => {
		const command = block("codex_commandExecution", {
			command: "git status --short",
			cwd: "/Users/blank/project",
			exitCode: 0,
		});
		const label = toolLabel(command);
		expect(label.name).not.toBe("codex_commandExecution");
		expect(label.detail).toBe("git status --short");
		expect(getShellCommand(command)).toBe("git status --short");
		expect(getShellCwd(command)).toBe("/Users/blank/project");
		expect(getShellExitCode(command)).toBe(0);
		expect(toolIcon(command.toolName)).toBe("icon-[mdi--console]");
	});

	it("summarizes Codex file changes instead of exposing the protocol item name", () => {
		const label = toolLabel(
			block("codex_fileChange", {
				changes: [{ path: "/repo/src/a.ts" }, { path: "/repo/src/b.ts" }],
			}),
		);
		expect(label.name).not.toBe("codex_fileChange");
		expect(label.detail).toContain("a.ts");
		expect(label.detail).toContain("+1");
	});

	it("shows Codex MCP server and tool identity", () => {
		expect(getCodexMcpInfo({ server: "github", tool: "search_code" })).toEqual({
			server: "github",
			tool: "search_code",
		});
		expect(toolLabel(block("codex_mcpToolCall", { server: "github", tool: "search_code" }))).toEqual({
			name: "MCP",
			detail: "github · search_code",
		});
	});

	it("uses the call description for MCP tools in Work mode", () => {
		expect(
			toolLabel(block("mcp_github_search_code", { description: "查找重复会话的实现", path: "src" }), true),
		).toEqual({ name: "查找重复会话的实现", detail: "src" });
	});
});
