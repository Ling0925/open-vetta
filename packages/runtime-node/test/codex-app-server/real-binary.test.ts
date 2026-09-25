import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Message } from "@vetta/ai";
import { RuntimeHost } from "@vetta/runtime-core";
import type { TurnEngineRequest } from "@vetta/runtime-core/kernel";
import {
	CodexConversationTurnEngine,
	CodexRuntimeHostBackend,
	openCodexAppServerSession,
	startCodexProviderBridge,
} from "@vetta/runtime-node/codex-app-server";
import { FileConversationOwnershipManager } from "@vetta/runtime-node/conversation";
import { describe, it, vi } from "vitest";
import { ANSWER_MARKER, FIXTURE_MODEL, startLocalResponsesFixture, TOOL_MARKER } from "./local-responses-fixture.js";

// Test-only pin. This is a compatibility candidate, not a supported-version claim for the app.
const VERSION = "0.157.0";
const executable = process.env.VETTA_CODEX_TEST_EXECUTABLE;
const entry = process.env.VETTA_CODEX_TEST_ENTRY;
const required = process.env.VETTA_CODEX_TEST_REQUIRED === "1";
if (required && (!executable || !entry))
	throw new Error("Real Codex is required but its executable/entry was not provided");

// Opt-in only: ordinary tests do not install or launch a real Codex executable.
describe.skipIf(!executable || !entry)("pinned real Codex with an isolated local model", () => {
	it("runs a real tool, restores authoritative history, follows up and confirms cancellation", async () => {
		assert.equal(
			process.platform,
			"linux",
			"Run this gate in the Linux network namespace from the validation workflow",
		);
		assert.ok(
			Object.values(networkInterfaces())
				.flat()
				.every((network) => !network || network.internal),
			"Refusing a real-binary test with non-loopback network interfaces",
		);
		assert.ok(executable && isAbsolute(executable));
		assert.ok(entry && isAbsolute(entry));
		await Promise.all([access(executable), access(entry)]);
		const root = await mkdtemp(join(tmpdir(), "vetta-real-codex-"));
		const home = join(root, "home");
		const cwd = join(root, "workspace");
		const codexHome = join(root, "codex");
		await Promise.all([mkdir(home), mkdir(cwd), mkdir(codexHome)]);
		// No user git/global Codex state, credentials, extensions or project files are reused.
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("APPDATA", home);
		vi.stubEnv("LOCALAPPDATA", home);
		let model: Awaited<ReturnType<typeof startLocalResponsesFixture>> | undefined;
		let bridge: Awaited<ReturnType<typeof startCodexProviderBridge>> | undefined;
		let host: RuntimeHost | undefined;
		try {
			model = await startLocalResponsesFixture(["tool", "answer", "answer", "hold"]);
			const baseUrl = model.baseUrl;
			bridge = await startCodexProviderBridge({
				resolve: async () => ({
					identity: "real-binary-contract",
					revision: "synthetic-key",
					model: FIXTURE_MODEL,
					baseUrl,
					headers: { authorization: "Bearer synthetic-contract-key" },
				}),
				fetch,
			});
			const backend = new CodexRuntimeHostBackend({
				catalogRoot: join(root, "catalog"),
				profile: {
					id: "contract",
					executable,
					executableArgs: [entry],
					expectedVersion: VERSION,
					codexHome,
					model: FIXTURE_MODEL,
					gateway: bridge.provider,
					providerIdentity: bridge.identity,
					requestTimeoutMs: 15000,
					interruptTimeoutMs: 10000,
					turnTimeoutMs: 45000,
				},
				ownership: new FileConversationOwnershipManager(),
			});
			host = new RuntimeHost({ createSessionBackend: () => backend, sessionCatalog: backend.catalog });
			const created = await host.createSession({ cwd, executionMode: "sandbox" });
			const first = await host.prompt(created.sessionId, {
				text: "Run the requested read-only contract command, then finish.",
			});
			assert.equal(first.status, "completed");
			assert.equal(
				model.requests.length,
				2,
				"The first turn must execute the requested tool and return its output to the model",
			);
			const input = model.requests[1].input;
			assert.ok(Array.isArray(input));
			assert.ok(
				input.some(
					(value: unknown) =>
						value &&
						typeof value === "object" &&
						"type" in value &&
						value.type === "function_call_output" &&
						"call_id" in value &&
						value.call_id === "call_contract" &&
						"output" in value &&
						JSON.stringify(value.output).includes(TOOL_MARKER),
				),
				`Missing the actual shell output: ${JSON.stringify(input.filter((value: unknown) => value && typeof value === "object" && "type" in value && value.type === "function_call_output")).slice(0, 4096)}`,
			);
			const before = host.getFullHistory(created.sessionId);
			assert.ok(JSON.stringify(before).includes(ANSWER_MARKER));
			const path = host.getSessionPath(created.sessionId);
			assert.ok(path);
			await host.disposeSession(created.sessionId);
			const restored = await host.createSession({ sessionPath: path, executionMode: "sandbox" });
			assert.equal(restored.sessionId, created.sessionId);
			assert.deepEqual(host.getFullHistory(restored.sessionId), before);
			assert.equal(
				(await host.prompt(restored.sessionId, { text: "Answer once without running another tool." })).status,
				"completed",
			);
			const waiting = host.prompt(restored.sessionId, { text: "Wait for the local response." });
			// Attach rejection handling before waiting for the remote synchronization point.
			void waiting.catch(() => undefined);
			await model.waitForRequest(3);
			await host.abort(restored.sessionId);
			assert.equal((await waiting).status, "cancelled");
			await model.waitForDisconnect(3);
			assert.equal(host.getState(restored.sessionId).isStreaming, false);
			assert.deepEqual(model.failures, []);
		} finally {
			// Keep cleanup failures visible while still revoking network access and removing test data.
			const results = await Promise.allSettled([host?.close(), bridge?.close(), model?.close()]);
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
			const failed = results.filter((result) => result.status === "rejected");
			assert.equal(failed.length, 0, "Real Codex cleanup did not finish successfully");
		}
	}, 90000);
	it("runs the original-conversation engine with real Codex tools and canonical context handoff", async () => {
		assert.equal(
			process.platform,
			"linux",
			"Run this gate in the Linux network namespace from the validation workflow",
		);
		assert.ok(
			Object.values(networkInterfaces())
				.flat()
				.every((network) => !network || network.internal),
			"Refusing a real-binary test with non-loopback network interfaces",
		);
		assert.ok(executable && isAbsolute(executable));
		assert.ok(entry && isAbsolute(entry));
		await Promise.all([access(executable), access(entry)]);
		const root = await mkdtemp(join(tmpdir(), "vetta-chat-codex-"));
		const cwd = join(root, "workspace");
		const home = join(root, "home");
		await Promise.all([mkdir(cwd), mkdir(home)]);
		const fixture = await startLocalResponsesFixture(["tool", "answer", "answer"]);
		const bridge = await startCodexProviderBridge({
			resolve: async () => ({
				identity: "chat",
				revision: "fixture",
				model: FIXTURE_MODEL,
				baseUrl: fixture.baseUrl,
				headers: { authorization: "Bearer synthetic-contract-key" },
			}),
			fetch,
		});
		let opened = 0;
		let closed = 0;
		const engine = new CodexConversationTurnEngine(async () => {
			const session = await openCodexAppServerSession({
				executable: executable!,
				...(entry ? { executableArgs: [entry] } : {}),
				expectedVersion: VERSION,
				codexHome: home,
				cwd,
				gateway: bridge.provider,
				sandbox: "workspace-write",
				onApproval: async () => "decline",
			});
			opened++;
			return {
				session,
				close: async () => {
					await session.close();
					closed++;
				},
			};
		});
		const messages: Message[] = [
			{ role: "user", content: "Run the harmless fixture command and report it.", timestamp: 1 },
		];
		try {
			for (let index = 0; index < 2; index++) {
				if (index > 0)
					messages.push({
						role: "user",
						content: "Continue with the previous result, do not repeat the command.",
						timestamp: 2,
					});
				const input = messages.at(-1)!;
				assert.equal(input.role, "user");
				if (input.role !== "user") throw new Error("Expected the current user request");
				const request: TurnEngineRequest = {
					sessionId: "same-chat",
					turnId: `chat-${index}`,
					snapshot: {
						id: "chat-contract",
						instructions: [],
						tools: new Map(),
						contextProviders: [],
						contextStrategy: { prepare: async (input) => ({ messages: input.messages, estimatedTokens: 1 }) },
						toolPolicy: { authorize: async () => true },
						tokenBudget: 8000,
						reservedOutputTokens: 1000,
						observers: [],
					},
					messages: [...messages],
					input: { message: input },
					signal: new AbortController().signal,
				};
				let finished = false;
				for await (const event of engine.execute(request)) {
					if (event.type === "message") messages.push(event.message);
					if (event.type === "completed") finished = true;
				}
				assert.equal(finished, true);
				assert.equal(opened, closed, "Next turn cannot start until its previous process is closed");
			}
			assert.equal(messages.filter((message) => message.role === "user").length, 2);
			assert.ok(
				messages.some(
					(message) => message.role === "toolResult" && JSON.stringify(message.content).includes(TOOL_MARKER),
				),
			);
			assert.equal(fixture.requests.length, 3, "History handoff must not execute the old tool again");
			assert.ok(JSON.stringify(fixture.requests[2].input).includes(ANSWER_MARKER));
			assert.deepEqual(fixture.failures, []);
		} finally {
			await bridge.close();
			await fixture.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 60000);
});
