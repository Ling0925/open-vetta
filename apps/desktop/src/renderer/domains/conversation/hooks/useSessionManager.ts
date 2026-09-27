import { pluginSendMessageRef } from "@domains/plugins/runtime/plugin-host-bridge";
import {
	abortMessageFnRef,
	cancelSessionOpenFnRef,
	type OpenSessionOptions,
	openSessionFnRef,
	type SendMessageOptions,
	type SendMessageResult,
	type SessionExecutionMode,
	sendMessageFnRef,
	sendQueuedNowFnRef,
} from "@shared/store/atoms";
import type { MutableRefObject } from "react";
import { useSessionMessageSender } from "./useSessionMessageSender";
import { useSessionOpener } from "./useSessionOpener";

interface SessionManagerResult {
	openSession: (
		cwd: string,
		sessionPath?: string,
		executionMode?: SessionExecutionMode,
		options?: OpenSessionOptions,
	) => Promise<void>;
	sendMessage: (overrideText?: string, options?: SendMessageOptions) => Promise<SendMessageResult | undefined>;
	abortMessage: () => Promise<void>;
	sendQueuedNow: (runtimeId: string, id: string) => Promise<void>;
	cancelSessionOpen: () => void;
	openSessionRef: MutableRefObject<SessionManagerResult["openSession"] | undefined>;
}

export function useSessionManager(): SessionManagerResult {
	const { openSession, openSessionRef, cancelSessionOpen, bumpSuggestionToken } = useSessionOpener();
	const { sendMessage, abortMessage, sendQueuedNow } = useSessionMessageSender({
		bumpSuggestionToken,
	});

	openSessionFnRef.current = openSession;
	cancelSessionOpenFnRef.current = cancelSessionOpen;
	pluginSendMessageRef.current = sendMessage;
	sendMessageFnRef.current = sendMessage;
	abortMessageFnRef.current = abortMessage;
	sendQueuedNowFnRef.current = sendQueuedNow;

	return { openSession, sendMessage, abortMessage, sendQueuedNow, cancelSessionOpen, openSessionRef };
}
