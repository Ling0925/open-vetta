import { createServer, type ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;
export type ResponsesStep =
	| { readonly type: "tool"; readonly name: string; readonly arguments: JsonObject }
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "hold" };

export const RESPONSES_FIXTURE_MODEL = "native-integration-fixture";
export const RESPONSES_FIXTURE_KEY = "synthetic-native-integration-key";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
	return value as JsonObject;
}

/** Replaces only the remote model; production Responses encoding and SSE decoding remain in use. */
export async function startScriptedResponsesServer(steps: readonly ResponsesStep[]) {
	const requests: JsonObject[] = [];
	const failures: string[] = [];
	const received = steps.map(() => deferred<void>());
	const disconnected = steps.map(() => deferred<void>());
	const server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.method !== "POST" || request.url !== "/v1/responses")
					throw new Error("Unexpected fixture route");
				if (request.headers.authorization !== `Bearer ${RESPONSES_FIXTURE_KEY}`)
					throw new Error("Unexpected fixture credential");
				const parts: Buffer[] = [];
				let size = 0;
				for await (const part of request) {
					const bytes = Buffer.from(part);
					size += bytes.length;
					if (size > 2 * 1024 * 1024) throw new Error("Fixture request too large");
					parts.push(bytes);
				}
				const body = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
				if (body.model !== RESPONSES_FIXTURE_MODEL) throw new Error("Unexpected model binding");
				const index = requests.length;
				const step = steps[index];
				if (!step) throw new Error("Unexpected additional model request");
				requests.push(body);
				response.once("close", () => disconnected[index].resolve());
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
				const base = { id: `response_${index}`, object: "response", created_at: 1, model: RESPONSES_FIXTURE_MODEL };
				event(response, "response.created", { response: { ...base, status: "in_progress", output: [] } });
				if (step.type === "hold") {
					response.flushHeaders();
					received[index].resolve();
					return;
				}
				if (step.type === "tool") {
					const tools = Array.isArray(body.tools) ? body.tools.map(object) : [];
					if (!tools.some((tool) => tool.type === "function" && tool.name === step.name))
						throw new Error(`Missing tool: ${step.name}`);
				}
				const item: JsonObject =
					step.type === "tool"
						? {
								id: `function_${index}`,
								type: "function_call",
								call_id: `call_${index}`,
								name: step.name,
								arguments: JSON.stringify(step.arguments),
								status: "completed",
							}
						: {
								id: `message_${index}`,
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: step.text, annotations: [] }],
							};
				event(response, "response.output_item.added", {
					output_index: 0,
					item: {
						...item,
						status: "in_progress",
						...(step.type === "tool" ? { arguments: "" } : { content: [] }),
					},
				});
				if (step.type === "tool") {
					event(response, "response.function_call_arguments.delta", {
						item_id: item.id,
						output_index: 0,
						delta: item.arguments,
					});
					event(response, "response.function_call_arguments.done", {
						item_id: item.id,
						output_index: 0,
						arguments: item.arguments,
					});
				} else {
					event(response, "response.content_part.added", {
						item_id: item.id,
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					});
					const split = Math.ceil(step.text.length / 2);
					for (const delta of [step.text.slice(0, split), step.text.slice(split)]) {
						event(response, "response.output_text.delta", {
							item_id: item.id,
							output_index: 0,
							content_index: 0,
							delta,
						});
					}
					event(response, "response.output_text.done", {
						item_id: item.id,
						output_index: 0,
						content_index: 0,
						text: step.text,
					});
					event(response, "response.content_part.done", {
						item_id: item.id,
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: step.text, annotations: [] },
					});
				}
				event(response, "response.output_item.done", { output_index: 0, item });
				event(response, "response.completed", {
					response: {
						...base,
						status: "completed",
						output: [item],
						usage: {
							input_tokens: 12,
							output_tokens: 6,
							total_tokens: 18,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					},
				});
				response.end();
				received[index].resolve();
			} catch (error) {
				failures.push(error instanceof Error ? error.message : "Fixture error");
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(400);
					response.end("Fixture rejected request");
				}
			}
		})();
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		failures,
		waitForRequest: (index: number) => received[index].promise,
		waitForDisconnect: (index: number) => disconnected[index].promise,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}

function event(response: ServerResponse, type: string, data: JsonObject) {
	response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
