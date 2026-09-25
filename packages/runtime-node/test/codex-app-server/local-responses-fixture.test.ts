import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ANSWER_MARKER, FIXTURE_MODEL, startLocalResponsesFixture, TOOL_MARKER } from "./local-responses-fixture.js";

function post(baseUrl: string, body: unknown, authorization = "Bearer synthetic-contract-key", signal?: AbortSignal) {
	return fetch(`${baseUrl}/responses`, { method: "POST", headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify(body), signal });
}
function events(text: string) {
	return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

describe("deterministic model fixture for real Codex contracts", () => {
	it("emits matching incremental and authoritative final text", async () => {
		const fixture = await startLocalResponsesFixture(["answer"]);
		try {
			const response = await post(fixture.baseUrl, { model: FIXTURE_MODEL, input: [] });
			assert.equal(response.status, 200);
			const frames = events(await response.text());
			assert.equal(frames[0].type, "response.created");
			assert.equal(frames.find((frame) => frame.type === "response.output_text.delta").delta, ANSWER_MARKER);
			assert.equal(frames.at(-1).response.output[0].content[0].text, ANSWER_MARKER);
			assert.deepEqual(fixture.failures, []);
		} finally { await fixture.close(); }
	});

	it("requests one advertised tool and accepts its paired output before the final answer", async () => {
		const fixture = await startLocalResponsesFixture(["tool", "answer"]);
		try {
			const first = await post(fixture.baseUrl, { model: FIXTURE_MODEL, input: [], tools: [{ type: "function", name: "shell_command" }] });
			const tool = events(await first.text()).at(-1).response.output[0];
			assert.equal(tool.type, "function_call");
			assert.equal(tool.name, "shell_command");
			assert.equal(JSON.parse(tool.arguments).command, `printf '${TOOL_MARKER}'`);
			const second = await post(fixture.baseUrl, { model: FIXTURE_MODEL,
				input: [{ type: "function_call_output", call_id: tool.call_id, output: TOOL_MARKER }] });
			assert.equal(events(await second.text()).at(-1).response.status, "completed");
			assert.equal(fixture.requests.length, 2);
			assert.deepEqual(fixture.failures, []);
		} finally { await fixture.close(); }
	});

	it("rejects the wrong credential or model without producing a success stream", async () => {
		const fixture = await startLocalResponsesFixture(["answer"]);
		try {
			const denied = await post(fixture.baseUrl, { model: FIXTURE_MODEL }, "Bearer wrong");
			assert.equal(denied.status, 400); await denied.text();
			const wrong = await post(fixture.baseUrl, { model: "wrong" });
			assert.equal(wrong.status, 400); await wrong.text();
			assert.equal(fixture.requests.length, 0);
		} finally { await fixture.close(); }
	});

	it("records an unsupported tool schema as a fixture failure instead of faking tool execution", async () => {
		const fixture = await startLocalResponsesFixture(["tool"]);
		try {
			await post(fixture.baseUrl, { model: FIXTURE_MODEL, tools: [] }).then((response) => response.text()).catch(() => undefined);
			assert.match(fixture.failures[0], /did not advertise/);
		} finally { await fixture.close(); }
	});

	it("holds an incomplete stream until the client cancels and observes the disconnection", async () => {
		const fixture = await startLocalResponsesFixture(["hold"]);
		const controller = new AbortController();
		try {
			const response = await post(fixture.baseUrl, { model: FIXTURE_MODEL }, undefined, controller.signal);
			await fixture.waitForRequest(0);
			const body = assert.rejects(response.text());
			controller.abort(); await body; await fixture.waitForDisconnect(0);
			assert.deepEqual(fixture.failures, []);
		} finally { controller.abort(); await fixture.close(); }
	});

	it("rejects unsolicited retries after the scripted sequence is complete", async () => {
		const fixture = await startLocalResponsesFixture(["answer"]);
		try {
			await (await post(fixture.baseUrl, { model: FIXTURE_MODEL })).text();
			const extra = await post(fixture.baseUrl, { model: FIXTURE_MODEL });
			assert.equal(extra.status, 400); await extra.text();
			assert.match(fixture.failures[0], /additional/);
		} finally { await fixture.close(); }
	});
});
