// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./shared/CopyIconButton", () => ({ CopyIconButton: () => null }));

import { BashTerminalCard } from "./BashTerminalCard";

describe("BashTerminalCard live output", () => {
	it("shows the latest output while the command is still running", () => {
		render(
			<BashTerminalCard
				command="long-running-command"
				partialResult="latest command output"
				result={undefined}
				status="pending"
				isError={undefined}
				startedAt={1}
				durationMs={undefined}
				phases={undefined}
			/>,
		);

		expect(screen.getByText("latest command output")).toBeTruthy();
		expect(screen.getByText("正在执行···")).toBeTruthy();
	});
});
