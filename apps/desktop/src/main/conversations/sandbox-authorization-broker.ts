import type {
	CodingAgentSandboxAuthorizationDecision,
	CodingAgentSandboxAuthorizationFunctionRequest,
} from "@vetta/coding-agent/function-extensions";

export type SandboxAuthorizationHandler = (
	request: CodingAgentSandboxAuthorizationFunctionRequest,
	signal?: AbortSignal,
) => Promise<CodingAgentSandboxAuthorizationDecision>;

/** Desktop renderer 生命周期与 Coding Agent sandbox authorization function 之间的可重绑路由。 */
export class DesktopSandboxAuthorizationBroker {
	private interactiveHandler: SandboxAuthorizationHandler | undefined;
	private readonly resolvedListeners = new Set<(event: { requestId: string; sessionId: string }) => void>();

	onResolved(listener: (event: { requestId: string; sessionId: string }) => void): () => void {
		this.resolvedListeners.add(listener);
		return () => this.resolvedListeners.delete(listener);
	}

	isAvailable(): boolean {
		return this.interactiveHandler !== undefined;
	}

	readonly handle: SandboxAuthorizationHandler = async (request, signal) => {
		if (signal?.aborted) return "deny";
		try {
			return await (this.interactiveHandler?.(request, signal) ?? Promise.resolve("deny"));
		} finally {
			for (const listener of this.resolvedListeners) {
				try {
					listener({ requestId: request.requestId, sessionId: request.sessionId });
				} catch {
					/* Renderer delivery cannot grant permission. */
				}
			}
		}
	};

	setInteractiveHandler(handler: SandboxAuthorizationHandler): () => void {
		this.interactiveHandler = handler;
		return () => {
			if (this.interactiveHandler === handler) this.interactiveHandler = undefined;
		};
	}
}

const sharedSandboxAuthorizationBroker = new DesktopSandboxAuthorizationBroker();

export function getDesktopSandboxAuthorizationBroker(): DesktopSandboxAuthorizationBroker {
	return sharedSandboxAuthorizationBroker;
}
