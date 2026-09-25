// Deterministic Codex boundary fixture; it performs only loopback HTTP and never accesses a model service.
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0-test"); process.exit(0); }
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
let gateway; let model; let counter = 0;
const thread = { id: "gateway-thread", turns: [] };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => { void receive(JSON.parse(line)); });
async function receive(frame) {
	if (frame.method === "initialize") return send({ id: frame.id, result: { userAgent: "gateway-fixture" } });
	if (frame.method === "initialized") return;
	const params = frame.params ?? {};
	if (frame.method === "thread/start" || frame.method === "thread/resume") {
		gateway = params.config?.model_providers?.[params.modelProvider]; model = params.model;
		if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.NO_PROXY !== "*") {
			return send({ id: frame.id, error: { code: -32602, message: "Unexpected proxy for loopback gateway" } });
		}
		if (!gateway || gateway.requires_openai_auth !== false || gateway.wire_api !== "responses" ||
			!gateway.base_url.startsWith("http://127.0.0.1:")) return send({ id: frame.id, error: { code: -32602, message: "Invalid fixture binding" } });
		return send({ id: frame.id, result: { thread, model, modelProvider: process.argv.includes("mismatch") ? "openai" : params.modelProvider,
			cwd: process.cwd(), sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" } });
	}
	if (frame.method === "turn/start") {
		const turn = { id: `turn-${++counter}`, status: "inProgress", items: [] };
		send({ id: frame.id, result: { turn } });
		try {
			const result = await fetch(`${gateway.base_url}/responses`, { method: "POST", headers: { ...gateway.http_headers, "content-type": "application/json" },
				body: JSON.stringify({ model, input: params.input }) });
			await result.text(); turn.status = result.ok ? "completed" : "failed";
		} catch { turn.status = "failed"; }
		thread.turns.push(turn);
		return send({ method: "turn/completed", params: { threadId: thread.id, turn } });
	}
	send({ id: frame.id, error: { code: -32601, message: "Unsupported fixture request" } });
}
