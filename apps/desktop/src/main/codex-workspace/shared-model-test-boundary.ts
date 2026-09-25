import type { CodexGatewaySource, CodexGatewayTarget } from "@vetta/runtime-node/codex-app-server";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

/** Only the external Codex host, credential store and filesystem ownership are faked.
 * The shared backend, admission and authenticated HTTP bridge under test remain real. */
export const boundary = {
	paused: false,
	entered: deferred<void>(),
	released: deferred<void>(),
	dispatched: 0,
	disposals: 0,
	failOpen: false,
	failDispose: false,
	readCount: 0,
	reset() {
		this.paused = false; this.entered = deferred<void>(); this.released = deferred<void>();
		this.dispatched = 0; this.disposals = 0; this.failOpen = false; this.failDispose = false; this.readCount = 0;
	},
};
const target: CodexGatewayTarget = {
	identity: "selected-model", revision: "credential-generation", model: "fixture",
	baseUrl: "https://fixture.invalid/v1", headers: {},
};

export function createDesktopCodexModelSource(): CodexGatewaySource {
	return {
		resolve: async () => {
			boundary.readCount++;
			if (boundary.paused) { boundary.entered.resolve(); await boundary.released.promise; }
			return target;
		},
		fetch: async () => { throw new Error("No live network in this test"); },
	};
}
export class CodexHostSessionCatalog {
	async listSessions() { return []; }
	async pathFor(id: string) { return `/fixture/${id}`; }
}
export class FileConversationOwnershipManager {}
export class CodexRuntimeHostBackend {
	async createAssembly() {
		if (boundary.failOpen) throw new Error("fixture startup failure");
		return {
			lifecycle: { sessionId: "session", dispose: () => this.dispose() },
			historyReader: { readHistory: () => [] },
			corePorts: {
				eventStream: { subscribe: () => () => {} },
				turnControl: {
					prompt: async () => { boundary.dispatched++; return { status: "completed", turnId: "turn" }; },
					promptWhenAvailable: async (_request: unknown, signal?: AbortSignal) => {
						signal?.throwIfAborted(); boundary.dispatched++; return { status: "completed", turnId: "turn" };
					},
					abort: async () => {},
				},
			},
		};
	}
	readSnapshot() { return { state: "idle" }; }
	async dispose() {
		boundary.disposals++;
		if (boundary.failDispose) throw new Error("fixture shutdown unconfirmed");
	}
}
