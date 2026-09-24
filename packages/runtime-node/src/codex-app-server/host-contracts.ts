import type { RuntimeHostSessionAssembly, SessionEvent } from "@vetta/runtime-core";
import type { ConversationOwnershipManager } from "@vetta/runtime-storage/conversation";
import type { CodexAppServerSession } from "./session.js";
import type { OpenCodexSessionOptions } from "./types.js";

/** Fixed host-selected profile. Never read executable, home or permissions from a session record. */
export interface CodexHostProfile extends Omit<OpenCodexSessionOptions, "cwd" | "threadId"> {
	readonly id: string;
	readonly codexHome: string;
}

/** An index, not another Conversation store. Codex owns messages, tools and authoritative history. */
export interface CodexSessionRecord {
	readonly schemaVersion: 1;
	readonly runtime: "codex-app-server";
	readonly sessionId: string;
	readonly threadId: string;
	readonly profileId: string;
	readonly profileFingerprint: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly modifiedAt: number;
	readonly name?: string;
	readonly firstMessage: string;
	readonly lastMessagePreview: string;
}

export interface CodexHostBackendOptions {
	readonly catalogRoot: string;
	readonly profile: CodexHostProfile;
	/** Use the existing FileConversationOwnershipManager in Node composition roots. */
	readonly ownership: ConversationOwnershipManager;
	/** External Codex connection boundary, also used by deterministic protocol/stdio tests. */
	readonly connect?: (options: OpenCodexSessionOptions) => Promise<CodexAppServerSession>;
}

export const CODEX_HOST_CAPABILITIES = Object.freeze({
	runtime: "codex-app-server" as const,
	textInput: true,
	streaming: true,
	historyRead: true,
	resume: true,
	stop: true,
	steer: true,
	renameLocal: true,
	followUpQueue: false,
	historyEdit: false,
	fork: false,
	deleteRemoteHistory: false,
	attachments: false,
	modelSelection: false,
	reasoningSelection: false,
	credentialSharing: false,
	manualCompaction: false,
	automaticRetry: false,
	nativeTools: false,
	nativeUsageAccounting: false,
	fullAccess: false,
});

/** Additional correlation is retained at runtime without changing the existing Native SessionEvent contract. */
export type CodexHostEvent = SessionEvent & {
	readonly codex: {
		readonly threadId: string;
		readonly turnId?: string;
		readonly itemId?: string;
	};
};

export interface CodexHostAssembly extends RuntimeHostSessionAssembly {
	/** Desktop composition must use this matrix before exposing Native-only controls. */
	readonly codexCapabilities: typeof CODEX_HOST_CAPABILITIES;
}
