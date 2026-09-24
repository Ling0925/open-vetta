import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CodexHostProjection } from "../../src/codex-app-server/host-projection.js";
import type { CodexSessionEvent, JsonObject } from "../../src/codex-app-server/types.js";

function fixture() {
	const projection = new CodexHostProjection("local", "thread");
	let sequence = 0;
	const event = (method: string, params: JsonObject): CodexSessionEvent => ({
		instanceId: "instance", threadId: "thread", sequence: ++sequence, method, params,
	});
	projection.accept(event("turn/started", { turn: { id: "turn" } }));
	return { projection, event, send: (method: string, params: JsonObject) => projection.accept(event(method, params)) };
}
const item = (text: string) => ({ id: "item", type: "agentMessage", text });
const terminal = (items: JsonObject[] = [], status = "completed") => ({
	id: "turn", status, items, itemsView: "notLoaded", error: status === "failed" ? { message: "failure" } : null,
});

describe("Codex item identity and authoritative history", () => {
	it("rejects malformed history atomically rather than exposing it to view readers", () => {
		const f = fixture(); f.send("item/completed", { turnId: "turn", item: item("valid") });
		const before = f.projection.readHistory();
		assert.throws(() => f.projection.replaceHistory({ id: "thread", turns: [{
			...terminal([{ id: "invalid", type: "userMessage", content: null }]), itemsView: "full",
		}] }), { code: "PROTOCOL" });
		assert.deepEqual(f.projection.readHistory(), before);
	});

	it("keeps streamed final items when a terminal payload has not loaded its items", () => {
		const f = fixture();
		f.send("item/started", { turnId: "turn", item: item("") });
		f.send("item/agentMessage/delta", { turnId: "turn", itemId: "item", delta: "partial" });
		f.send("item/completed", { turnId: "turn", item: item("complete answer") });
		f.send("turn/completed", { turn: terminal() });
		const messages = f.projection.readMessages();
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0].content, [{ type: "text", text: "complete answer" }]);
	});
	it("does not finalize a summary-only terminal item over a longer streamed answer", () => {
		const f = fixture();
		f.send("item/agentMessage/delta", { turnId: "turn", itemId: "item", delta: "long streamed answer" });
		const events = f.send("turn/completed", { turn: { ...terminal([item("short summary")]), itemsView: "summary" } });
		assert.deepEqual(f.projection.readMessages()[0].content, [{ type: "text", text: "long streamed answer" }]);
		assert.equal(events.some((event) => event.type === "message.final"), false);
	});

	it("final text replaces deltas, and neither duplicate start nor late delta rolls it back", () => {
		const f = fixture();
		f.send("item/started", { turnId: "turn", item: item("") });
		f.send("item/agentMessage/delta", { turnId: "turn", itemId: "item", delta: "part" });
		f.send("item/started", { turnId: "turn", item: item("") });
		assert.deepEqual(f.projection.readMessages()[0].content, [{ type: "text", text: "part" }]);
		f.send("item/completed", { turnId: "turn", item: item("final") });
		assert.deepEqual(f.send("item/agentMessage/delta", { turnId: "turn", itemId: "item", delta: "late" }), []);
		assert.deepEqual(f.projection.readMessages()[0].content, [{ type: "text", text: "final" }]);
	});
	it("merges the same item ID once and ignores repeated transport sequence numbers", () => {
		const f = fixture();
		const e = f.event("item/completed", { turnId: "turn", item: item("final") });
		assert.equal(f.projection.accept(e).length, 1);
		assert.deepEqual(f.projection.accept(e), []);
		assert.deepEqual(f.send("item/completed", { turnId: "turn", item: item("duplicate") }), []);
		assert.equal(f.projection.readMessages().length, 1);
	});
	it("keeps stable item identities after loading a full authoritative history", () => {
		const f = fixture(); f.send("item/completed", { turnId: "turn", item: item("final") });
		const before = f.projection.readHistory()[0];
		f.projection.replaceHistory({ id: "thread", turns: [{ ...terminal([item("final")]), itemsView: "full", startedAt: 123 }] });
		const after = f.projection.readHistory()[0];
		assert.equal(before.type, "message"); assert.equal(after.type, "message");
		if (before.type !== "message" || after.type !== "message") throw new Error("expected messages");
		assert.equal(after.entryId, before.entryId); assert.equal(after.message.timestamp, 123000);
	});
	it("rejects summary-only history rather than replacing the current view with an empty one", () => {
		const f = fixture(); f.send("item/completed", { turnId: "turn", item: item("final") });
		const before = f.projection.readHistory();
		assert.throws(() => f.projection.replaceHistory({ id: "thread", turns: [terminal()] }), { code: "HISTORY_INCOMPLETE" });
		assert.deepEqual(f.projection.readHistory(), before);
	});
	it("rejects mixed process generations and drops events from another thread or old turn", () => {
		const f = fixture();
		const e = f.event("item/completed", { turnId: "turn", item: item("foreign") });
		assert.deepEqual(f.projection.accept({ ...e, threadId: "other" }), []);
		assert.throws(() => f.projection.accept({ ...e, instanceId: "replacement-process" }), { code: "PROTOCOL" });
		f.send("turn/completed", { turn: terminal() });
		assert.deepEqual(f.send("item/completed", { turnId: "turn", item: item("late") }), []);
	});
	it("tool failure and unknown exit status are never represented as successful execution", () => {
		for (const exitCode of [1, null]) {
			const f = fixture();
			const value = { id: "tool", type: "commandExecution", status: "completed", command: "test", exitCode, aggregatedOutput: "output" };
			const events = f.send("item/completed", { turnId: "turn", item: value });
			const end = events.find((event) => event.type === "tool.end");
			assert.ok(end && end.type === "tool.end"); assert.equal(end.isError, true);
			const messages = f.projection.readMessages();
			assert.equal(messages.length, 2); assert.equal(messages[0].role, "assistant"); assert.equal(messages[1].role, "toolResult");
		}
	});
	it("retains unknown Codex items without treating them as executable Native tools", () => {
		const f = fixture();
		f.send("item/completed", { turnId: "turn", item: { id: "unknown", type: "futureItem", payload: "opaque" } });
		assert.equal(f.projection.readMessages().length, 0);
		const history = f.projection.readHistory();
		assert.equal(history[0].type, "custom_marker");
	});
	it("emits one end for a failed or interrupted turn and retains explicit failure in history", () => {
		for (const status of ["failed", "interrupted"]) {
			const f = fixture();
			const end = f.send("turn/completed", { turn: terminal([], status) });
			assert.equal(end.filter((e) => e.type === "session.lifecycle" && e.phase === "agent_end").length, 1);
			assert.deepEqual(f.send("turn/completed", { turn: terminal([], status) }), []);
			assert.equal(f.projection.readHistory()[0].type, status === "failed" ? "error" : "custom_marker");
		}
	});
	it("does not emit usage measurements for display-only compatibility messages", () => {
		const f = fixture();
		const events = f.send("item/completed", { turnId: "turn", item: item("answer") });
		assert.equal(events.some((event) => event.type === "usage.update"), false);
		const message = f.projection.readMessages()[0];
		assert.equal(message.role, "assistant");
		if (message.role === "assistant") assert.equal(message.usage.cacheUsageReporting, "unavailable");
	});
});
