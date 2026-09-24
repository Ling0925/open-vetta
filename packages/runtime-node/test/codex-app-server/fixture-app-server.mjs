// Deterministic external-process boundary fixture. Never invokes a model or a shell tool.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const mode = process.argv[2];
if (process.argv.includes("--version")) {
	console.log("codex-cli 0.0.0-test");
	process.exit(0);
}
if (!process.argv.includes("app-server") || !process.argv.includes("stdio://"))
	process.exit(2);
const directory = process.env.CODEX_HOME;
const historyFile = join(directory, "fixture-history.json");
const pidFile = join(directory, "fixture-pid");
writeFileSync(pidFile, String(process.pid));
let thread = { id: "thread-fixture", turns: [] };
let active;
let initialized = false;
let seenInitialize = false;
let number = 0;
let approval;
if (mode === "hung-close")
	setInterval(() => { }, 1000);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notification = (method, params) => emit({ method, params });
const makeTurn = (id, status = "inProgress", items = []) => ({ id, status, items, error: null });
function terminal(status = "completed", content = "完成") {
	const item = { type: "agentMessage", id: `item-${active.id}`, text: content, phase: "final_answer" };
	active = { ...active, status, items: [item] };
	thread.turns = [...thread.turns.filter((turn) => turn.id !== active.id), active];
	writeFileSync(historyFile, JSON.stringify(thread));
	notification("item/completed", { threadId: thread.id, turnId: active.id, item });
	notification("turn/completed", { threadId: thread.id, turn: active });
}
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
	const message = JSON.parse(line);
	if (!message.method) {
		if (approval && message.id === approval)
			terminal("completed", JSON.stringify(message.result ?? message.error));
		return;
	}
	const params = message.params ?? {};
	if (message.method === "initialize") {
		if (mode === "invalid-json") {
			process.stdout.write("{bad-json}\n");
			return;
		}
		if (mode === "invalid-utf8") {
			process.stdout.write(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d, 10]));
			return;
		}
		if (mode === "oversize") {
			process.stdout.write("x".repeat(10000));
			return;
		}
		if (mode === "eof") {
			process.exit(0);
		}
		seenInitialize = true;
		emit({ id: message.id, result: { userAgent: "fixture/0.0.0-test" } });
		return;
	}
	if (message.method === "initialized") {
		initialized = seenInitialize;
		return;
	}
	if (!initialized) {
		emit({ id: message.id, error: { code: -32600, message: "Not initialized" } });
		return;
	}
	if (message.method === "thread/start" || message.method === "thread/resume") {
		if (message.method === "thread/resume")
			thread = JSON.parse(readFileSync(historyFile, "utf8"));
		number = thread.turns.length;
		const writable = params.sandbox === "workspace-write";
		const sandbox = mode === "bad-policy" ? { type: "dangerFullAccess" } : {
			type: writable ? "workspaceWrite" : "readOnly", networkAccess: mode === "network",
			...(writable ? { writableRoots: mode === "outside-root" ? [directory] : [], excludeTmpdirEnvVar: false, excludeSlashTmp: false } : {}),
		};
		emit({ id: message.id, result: { thread, model: "fixture", modelProvider: "fixture", cwd: process.cwd(), sandbox,
				approvalPolicy: params.approvalPolicy, approvalsReviewer: mode === "auto-review" ? "auto_review" : params.approvalsReviewer } });
		return;
	}
	if (message.method === "thread/read") {
		emit({ id: message.id, result: { thread } });
		return;
	}
	if (message.method === "turn/start") {
		active = makeTurn(`turn-${++number}`);
		emit({ id: message.id, result: { turn: active } });
		notification("turn/started", { threadId: thread.id, turn: active });
		const prompt = params.input[0].text;
		if (prompt === "wait")
			return;
		if (prompt === "approve") {
			approval = `approval-${active.id}`;
			emit({ id: approval, method: "item/commandExecution/requestApproval", params: {
					threadId: thread.id, turnId: active.id, itemId: "command-1", availableDecisions: ["accept", "decline", "cancel"],
				} });
			return;
		}
		if (prompt === "environment") {
			terminal("completed", JSON.stringify({ tokenForwarded: "VETTA_TEST_PRIVATE_TOKEN" in process.env,
				providerKeyForwarded: "OPENAI_API_KEY" in process.env, home: process.env.CODEX_HOME }));
			return;
		}
		// Split a multi-byte Chinese character across two actual pipe writes.
		const delta = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
				threadId: thread.id, turnId: active.id, itemId: `item-${active.id}`, delta: "你好",
			} })}\n`);
		const split = delta.indexOf(Buffer.from("你好")) + 1;
		process.stdout.write(delta.subarray(0, split));
		setImmediate(() => { process.stdout.write(delta.subarray(split)); terminal(); });
		return;
	}
	if (message.method === "turn/steer") {
		emit({ id: message.id, result: { turnId: active.id } });
		return;
	}
	if (message.method === "turn/interrupt") {
		emit({ id: message.id, result: {} });
		terminal("interrupted");
		return;
	}
	emit({ id: message.id, error: { code: -32601, message: "Unsupported fixture method" } });
});
