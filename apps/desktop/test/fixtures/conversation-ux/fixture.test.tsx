// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { historyRequests, installFixturePreload } from "./host";
import type { App as FixtureApp } from "./main";

let App: typeof FixtureApp;
beforeAll(async () => {
	installFixturePreload();
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get() {
			return 600;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get() {
			return 600;
		},
	});
	Object.defineProperty(Element.prototype, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions) {
			this.scrollTop = options.top ?? 0;
			this.dispatchEvent(new Event("scroll"));
		},
	});
	({ App } = await import("./main"));
});
afterEach(() => {
	cleanup();
	historyRequests.splice(0);
});

function mount() {
	return render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
			<App />
		</VirtuosoMockContext.Provider>,
	);
}

describe("real conversation browser fixture component wiring", () => {
	it("renders successive stream updates and releases the visible running state on cancel", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Stream 36 chunks" }));
		const conversation = screen.getByRole("main", { name: "Conversation A" });
		await waitFor(() => expect(conversation.textContent).toContain("A update 2:"));
		expect(screen.getByTestId("fixture-state").textContent).toContain("streaming");
		fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
		expect(screen.getByTestId("fixture-state").textContent).toContain("idle");
		expect(screen.getByTestId("fixture-state").textContent).toContain("source stopped");
		expect(conversation.textContent).toContain("A update 2:");
	});

	it("switches A → B → A and drops an obsolete session event", async () => {
		mount();
		await screen.findByText("A: This history belongs only to session A.");
		fireEvent.click(screen.getByRole("button", { name: "Session B" }));
		await screen.findByText("B: This history belongs only to session B.");
		expect(screen.queryByText("A: This history belongs only to session A.")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Inject old-session event" }));
		expect(screen.queryByText(/WRONG SESSION EVENT/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Session A" }));
		await screen.findByText("A: This history belongs only to session A.");
	});

	it("keeps a new turn visible when older history is released after cancellation", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "New turn" }));
		fireEvent.click(screen.getByRole("button", { name: "Ordered text / thinking" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
		await waitFor(() => expect(screen.getByTestId("fixture-state").textContent).toContain("idle"));
		fireEvent.click(screen.getByRole("button", { name: "New turn" }));
		await screen.findByText("A: New request 2");
		fireEvent.click(screen.getByRole("button", { name: "Release old history" }));
		await act(async () => {});
		expect(screen.queryByText("A: OLD history answer")).toBeNull();
		expect(screen.getByText("A: New request 2")).toBeDefined();
		expect(screen.getByTestId("fixture-state").textContent).toContain("streaming");
	});

	it("renders command progress then completion through actual tool card wiring", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "New turn" }));
		fireEvent.click(screen.getByRole("button", { name: "Start tool" }));
		fireEvent.click(screen.getByRole("button", { name: "Tool progress" }));
		const conversation = screen.getByRole("main", { name: "Conversation A" });
		await waitFor(() => expect(conversation.textContent).toContain("fixture"));
		fireEvent.click(await within(conversation).findByText("Check the isolated fixture"));
		await within(conversation).findByText(/12 checks completed/);
		fireEvent.click(screen.getByRole("button", { name: "Finish tool" }));
		await waitFor(() => expect(within(conversation).queryByText(/All 12 fixture checks passed/)).not.toBeNull());
	});
});
