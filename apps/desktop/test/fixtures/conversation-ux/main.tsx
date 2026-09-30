import { MessageList } from "@domains/conversation/components/MessageList";
import { useSessionEventController } from "@domains/conversation/hooks/useSessionEventController";
import { resetStreamState, setChatStreamOwner } from "@domains/conversation/services/chat-service";
import { Button } from "@shared/components/ui/button";
import { createConversationAgentMessage, createConversationUserMessage } from "@shared/conversation";
import { initI18n } from "@shared/i18n";
import { activeSessionStreamingAtom, type ChatConversationItem, chatMessagesAtom } from "@shared/store/atoms";
import type { HistoryEntry, SessionEvent } from "@vetta/runtime-core";
import { getDefaultStore, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { historyRequests } from "./host";
import "../../../src/renderer/styles.css";
import "./fixture.css";

initI18n();
const store = getDefaultStore();
const handles = {
	A: { runtimeId: "fixture-A", sessionPath: "/fixture/A.jsonl", cwd: "/fixture" },
	B: { runtimeId: "fixture-B", sessionPath: "/fixture/B.jsonl", cwd: "/fixture" },
};
type SessionKey = keyof typeof handles;
const user = (id: string, text: string) => createConversationUserMessage({ id, text, timestamp: 1000 });
const agent = (id: string, text: string) =>
	createConversationAgentMessage({ id, text, blocks: [{ type: "text", id: `${id}-text`, text }], timestamp: 2000 });
const seed = (key: SessionKey): ChatConversationItem[] => [
	user(`${key}-user`, `${key}: Please inspect this conversation.`),
	agent(`${key}-answer`, `${key}: This history belongs only to session ${key}.`),
];
let eventCounter = 0;

export function App() {
	const [active, setActive] = useState<SessionKey>("A");
	const [notice, setNotice] = useState("Ready. Synthetic data, real event controller and message components.");
	const [running, setRunning] = useState(false);
	const [turn, setTurn] = useState(0);
	const activeRef = useRef(handles.A);
	const cache = useRef<Record<SessionKey, { messages: ChatConversationItem[]; streaming: boolean }>>({
		A: { messages: seed("A"), streaming: false },
		B: { messages: seed("B"), streaming: false },
	});
	const messages = useAtomValue(chatMessagesAtom);
	const streaming = useAtomValue(activeSessionStreamingAtom);
	const controller = useSessionEventController({ activeSessionRef: activeRef });
	const handlers = useRef(new Map<string, (event: SessionEvent) => void>());
	const streamTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	function emit(key: SessionKey, payload: Record<string, unknown>) {
		const sessionId = handles[key].runtimeId;
		let handler = handlers.current.get(sessionId);
		if (!handler) {
			handler = controller.createSessionEventHandler(sessionId);
			handlers.current.set(sessionId, handler);
		}
		handler({
			schemaVersion: 1,
			channel: "runtime",
			source: "runtime-core",
			sessionId,
			timestamp: Date.now(),
			eventId: `fixture-${++eventCounter}`,
			...payload,
		} as SessionEvent);
	}
	function stopTimer() {
		clearInterval(streamTimer.current);
		streamTimer.current = undefined;
		setRunning(false);
	}
	function switchSession(key: SessionKey) {
		cache.current[active] = {
			messages: store.get(chatMessagesAtom),
			streaming: store.get(activeSessionStreamingAtom),
		};
		controller.resetEventBuffers();
		resetStreamState();
		activeRef.current = handles[key];
		setChatStreamOwner(handles[key].runtimeId);
		store.set(chatMessagesAtom, cache.current[key].messages);
		store.set(activeSessionStreamingAtom, cache.current[key].streaming);
		setActive(key);
		setNotice(`Selected session ${key}; old-session events must stay out.`);
	}
	function startTurn() {
		stopTimer();
		setTurn((value) => value + 1);
		store.set(chatMessagesAtom, (old) => [
			...old,
			user(`${active}-prompt-${eventCounter}`, `${active}: New request ${turn + 1}`),
		]);
		emit(active, { type: "session.lifecycle", phase: "agent_start" });
		setNotice(`Session ${active}: reply started`);
	}
	function stream() {
		startTurn();
		setRunning(true);
		const owner = active;
		let index = 0;
		streamTimer.current = setInterval(() => {
			emit(owner, {
				type: "message.delta",
				delta: `${owner} update ${++index}: The real message renderer is receiving incremental output.\n\n`,
			});
			if (index >= 36) stopTimer();
		}, 180);
	}
	function toolStep(stage: "start" | "update" | "end") {
		const base = { toolCallId: "fixture-command", toolName: "bash" };
		if (stage === "start")
			emit(active, {
				type: "tool.start",
				...base,
				args: { command: "fixture-check", description: "Check the isolated fixture" },
				startedAt: Date.now(),
			});
		if (stage === "update")
			emit(active, {
				type: "tool.update",
				...base,
				partialResult: {
					content: [{ type: "text", text: "Checking fixture...\n12 checks completed\nWaiting for final result" }],
				},
			});
		if (stage === "end")
			emit(active, {
				type: "tool.end",
				...base,
				result: { content: [{ type: "text", text: "All 12 fixture checks passed" }] },
				isError: false,
				durationMs: 1200,
				phases: [],
			});
	}
	function releaseHistory() {
		const request = historyRequests.shift();
		if (!request) {
			setNotice("No history response is waiting");
			return;
		}
		const key = request.sessionId.endsWith("B") ? "B" : "A";
		request.resolve([
			{
				type: "message",
				entryId: `${key}-stored-user`,
				message: { role: "user", content: `${key}: OLD history question`, timestamp: 1 },
			},
			{
				type: "message",
				entryId: `${key}-stored-agent`,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `${key}: OLD history answer` }],
					timestamp: 2,
					model: "fixture",
					provider: "fixture",
					api: "fixture",
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
		] as HistoryEntry[]);
		setNotice(`Released delayed ${key} history. A newer turn or session must remain intact.`);
	}
	useEffect(() => {
		store.set(chatMessagesAtom, seed("A"));
		setChatStreamOwner(handles.A.runtimeId);
		return () => {
			clearInterval(streamTimer.current);
			setChatStreamOwner(null);
		};
	}, []);
	return (
		<div className="fixture-shell">
			<aside className="fixture-controls">
				<h1>Conversation UX fixture</h1>
				<p>Local component fixture · mock IPC · no model or account</p>
				<nav aria-label="Fixture sessions">
					<Button variant={active === "A" ? "default" : "outline"} onClick={() => switchSession("A")}>
						Session A
					</Button>
					<Button variant={active === "B" ? "default" : "outline"} onClick={() => switchSession("B")}>
						Session B
					</Button>
				</nav>
				<Button onClick={startTurn}>New turn</Button>
				<Button onClick={stream}>Stream 36 chunks</Button>
				<Button
					onClick={() => {
						emit(active, { type: "message.delta", delta: `${active}: Text before thinking. ` });
						emit(active, { type: "thinking.delta", delta: "Fixture reasoning between text blocks." });
						emit(active, { type: "message.delta", delta: "Text after thinking." });
					}}
				>
					Ordered text / thinking
				</Button>
				<Button variant="outline" onClick={() => toolStep("start")}>
					Start tool
				</Button>
				<Button variant="outline" onClick={() => toolStep("update")}>
					Tool progress
				</Button>
				<Button variant="outline" onClick={() => toolStep("end")}>
					Finish tool
				</Button>
				<Button
					variant="outline"
					onClick={() => {
						stopTimer();
						emit(active, { type: "session.lifecycle", phase: "agent_end" });
						setNotice("Turn ended; history response intentionally held.");
					}}
				>
					Complete turn
				</Button>
				<Button
					variant="destructive"
					onClick={() => {
						stopTimer();
						emit(active, { type: "session.lifecycle", phase: "aborted" });
						setNotice("Cancelled; a new turn should remain available.");
					}}
				>
					Cancel turn
				</Button>
				<Button variant="outline" onClick={releaseHistory}>
					Release old history
				</Button>
				<Button
					variant="outline"
					onClick={() => {
						store.set(chatMessagesAtom, (old) => [
							...Array.from({ length: 25 }, (_, i) => [
								user(`${active}-old-u-${i}`, `${active}: Earlier question ${i + 1}`),
								agent(
									`${active}-old-a-${i}`,
									`${active}: Earlier answer ${i + 1}.\n\n${"A deterministic history paragraph with enough height to test virtualization. ".repeat(4)}`,
								),
							]).flat(),
							...old,
						]);
						setNotice("Prepended 50 historical messages");
					}}
				>
					Prepend 50 history rows
				</Button>
				<Button
					variant="outline"
					onClick={() => {
						const key = active === "A" ? "B" : "A";
						emit(key, { type: "message.delta", delta: "WRONG SESSION EVENT" });
						setNotice(`Injected an obsolete ${key} event`);
					}}
				>
					Inject old-session event
				</Button>
				<output className="fixture-status">{notice}</output>
				<output data-testid="fixture-state">
					Session {active} · {streaming ? "streaming" : "idle"} · {messages.length} messages ·{" "}
					{running ? "source running" : "source stopped"}
				</output>
			</aside>
			<main className="fixture-conversation" aria-label={`Conversation ${active}`}>
				<header>
					<strong>Session {active}</strong>
					<span>{streaming ? "Responding…" : "Ready"}</span>
				</header>
				<div className="fixture-feed">
					<MessageList
						messages={messages}
						isStreaming={streaming}
						sessionId={handles[active].sessionPath}
						workspace={{ id: "fixture", cwd: "/fixture", runtimeIds: [] }}
						onAbort={() => {
							stopTimer();
							emit(active, { type: "session.lifecycle", phase: "aborted" });
						}}
					/>
				</div>
			</main>
		</div>
	);
}

export function mountFixture(): void {
	createRoot(document.getElementById("root")!).render(<App />);
}
