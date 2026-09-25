import { createServer, type ServerResponse } from "node:http";

export const FIXTURE_MODEL = "gpt-5.4";
export const TOOL_MARKER = "VETTA_CODEX_TOOL_OK";
export const ANSWER_MARKER = "Vetta runtime contract verified.";

type ObjectValue = Record<string, unknown>;
export type FixtureStep = "tool" | "answer" | "hold";

function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
	return value as ObjectValue;
}

function latch() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => { resolve = accept; });
	return { promise, resolve };
}

/** Deterministic model boundary only. The real Codex/Host/tool implementations are not replaced. */
export async function startLocalResponsesFixture(steps: readonly FixtureStep[]) {
	const received = steps.map(() => latch());
	const disconnected = steps.map(() => latch());
	const requests: ObjectValue[] = [];
	const failures: string[] = [];
	let stopped = false;
	let closing: Promise<void> | undefined;
	const server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.method !== "POST" || request.url !== "/v1/responses") throw new Error("Unexpected fixture route");
				if (request.headers.authorization !== "Bearer synthetic-contract-key") throw new Error("Incorrect fixture credential");
				let size = 0;
				const parts: Buffer[] = [];
				for await (const chunk of request) {
					const bytes = Buffer.from(chunk);
					size += bytes.length;
					if (size > 16 * 1024 * 1024) throw new Error("Fixture request exceeded limit");
					parts.push(bytes);
				}
				const body = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
				if (body.model !== FIXTURE_MODEL) throw new Error("Unexpected fixture model");
				const index = requests.length;
				const step = steps[index];
				if (!step || stopped) throw new Error("Unexpected additional model request");
				requests.push(body);
				response.once("close", () => disconnected[index].resolve());
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
				const base = { id: `resp_contract_${index}`, object: "response", created_at: 1, model: FIXTURE_MODEL };
				event(response, "response.created", { response: { ...base, status: "in_progress", output: [] } });
				if (step === "hold") {
					response.flushHeaders();
					received[index].resolve();
					return;
				}
				const item: ObjectValue = step === "tool" ? shellCall(body.tools) : {
					id: `msg_contract_${index}`, type: "message", role: "assistant", status: "completed",
					content: [{ type: "output_text", text: ANSWER_MARKER, annotations: [] }],
				};
				event(response, "response.output_item.added", { output_index: 0,
					item: { ...item, status: "in_progress", ...(step === "tool" ? { arguments: "" } : { content: [] }) } });
				if (step === "tool") {
					event(response, "response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
					event(response, "response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments });
				} else {
					event(response, "response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0,
						part: { type: "output_text", text: "", annotations: [] } });
					event(response, "response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: ANSWER_MARKER });
					event(response, "response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: ANSWER_MARKER });
					event(response, "response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0,
						part: { type: "output_text", text: ANSWER_MARKER, annotations: [] } });
				}
				event(response, "response.output_item.done", { output_index: 0, item });
				event(response, "response.completed", { response: { ...base, status: "completed", output: [item],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
				response.end();
				received[index].resolve();
			} catch (error) {
				// All data is synthetic; store a bounded diagnostic without echoing request bodies or headers.
				failures.push(error instanceof Error ? error.message.slice(0, 200) : "Fixture failure");
				if (response.headersSent) response.destroy();
				else { response.writeHead(400); response.end("Fixture rejected request"); }
			}
		})();
	});
	server.headersTimeout = 5000;
	server.requestTimeout = 10000;
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, failures,
		waitForRequest: (index: number) => wait(received[index]?.promise),
		waitForDisconnect: (index: number) => wait(disconnected[index]?.promise),
		close: () => {
			if (closing) return closing;
			stopped = true;
			closing = new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
				server.closeAllConnections();
			});
			return closing;
		},
	};
}

function event(response: ServerResponse, type: string, data: ObjectValue) {
	response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function shellCall(value: unknown): ObjectValue {
	const tools = Array.isArray(value) ? value.map(object) : [];
	for (const name of ["shell_command", "exec_command", "shell"]) {
		if (!tools.some((tool) => tool.type === "function" && tool.name === name)) continue;
		const command = `printf '${TOOL_MARKER}'`;
		const args = name === "shell_command" ? { command, timeout_ms: 1000 } :
			name === "exec_command" ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 100 } :
			{ command: ["/bin/sh", "-c", command], timeout_ms: 1000 };
		return { id: "fc_contract", type: "function_call", call_id: "call_contract", name,
			arguments: JSON.stringify(args), status: "completed" };
	}
	throw new Error("Pinned Codex did not advertise a supported shell tool");
}

async function wait(promise?: Promise<void>): Promise<void> {
	if (!promise) throw new Error("Invalid fixture step");
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error("Fixture synchronization timed out")), 15000);
		})]);
	} finally { if (timeout) clearTimeout(timeout); }
}
