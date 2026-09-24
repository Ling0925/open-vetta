// External Codex process fixture: no model, shell tools, user credentials or network requests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
	console.log("codex-cli 0.0.0-test");
	process.exit(0);
}
if (!process.argv.includes("app-server") || !process.argv.includes("stdio://")) process.exit(2);
const historyPath = join(process.env.CODEX_HOME, "host-fixture-history.json");
writeFileSync(join(process.env.CODEX_HOME, "host-fixture-pid"), String(process.pid));
let thread = { id: "host-fixture-thread", turns: [] };
let active;
let initialized = false;
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => emit({ method, params: { threadId: thread.id, ...params } });
const save = () => writeFileSync(historyPath, JSON.stringify(thread));
function finish(status = "completed") {
	const item = { type: "agentMessage", id: `answer-${active.id}`, text: "完整回复", phase: "final_answer" };
	const tool = { id: `tool-${active.id}`, type: "commandExecution", command: "fixture-only", cwd: process.cwd(),
		status: "completed", aggregatedOutput: "fixture output", exitCode: 0, durationMs: 1 };
	notify("item/started", { turnId: active.id, item: { ...tool, status: "inProgress", exitCode: null } });
	notify("item/completed", { turnId: active.id, item: tool });
	const delta = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: thread.id,
		turnId: active.id, itemId: item.id, delta: "完整回复" } })}\n`);
	const split = delta.indexOf(Buffer.from("完整")) + 1;
	process.stdout.write(delta.subarray(0, split));
	process.stdout.write(delta.subarray(split));
	active = { ...active, status, items: [...active.items, tool, item] };
	thread.turns.push(active); save();
	notify("item/completed", { turnId: active.id, item });
	notify("turn/completed", { turn: { ...active, itemsView: "notLoaded", items: [] } });
	active = undefined;
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
	const frame = JSON.parse(line);
	const params = frame.params ?? {};
	if (frame.method === "initialize") return emit({ id: frame.id, result: { userAgent: "host-fixture" } });
	if (frame.method === "initialized") { initialized = true; return; }
	if (!initialized) return emit({ id: frame.id, error: { code: -32600, message: "initialize first" } });
	if (frame.method === "thread/start" || frame.method === "thread/resume") {
		if (frame.method === "thread/resume" && existsSync(historyPath)) thread = JSON.parse(readFileSync(historyPath, "utf8"));
		return emit({ id: frame.id, result: { thread, model: "fixture", cwd: process.cwd(),
			sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" } });
	}
	if (frame.method === "thread/read") return emit({ id: frame.id, result: { thread } });
	if (frame.method === "turn/start") {
		const prompt = params.input[0].text;
		if (prompt === "reject") return emit({ id: frame.id, error: { code: -32602, message: "fixture rejection" } });
		active = { id: `t${thread.turns.length + 1}`, status: "inProgress", itemsView: "full", startedAt: 123, error: null,
			items: [{ id: `u${thread.turns.length + 1}`, type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] };
		emit({ id: frame.id, result: { turn: { ...active, items: [], itemsView: "notLoaded" } } });
		notify("turn/started", { turn: active });
		notify("item/completed", { turnId: active.id, item: active.items[0] });
		if (prompt === "exit") { process.exit(3); }
		if (prompt !== "wait") finish();
		return;
	}
	if (frame.method === "turn/steer") return emit({ id: frame.id, result: { turnId: active.id } });
	if (frame.method === "turn/interrupt") { emit({ id: frame.id, result: {} }); finish("interrupted"); return; }
	emit({ id: frame.id, error: { code: -32601, message: "unsupported fixture method" } });
});
