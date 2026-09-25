/** Completion is not an approval; it removes stale permission requests after cancellation or response. */
export const SANDBOX_GRANT_RESOLVED_CHANNEL = "vetta:session:sandbox-grant-resolved";
export interface SandboxGrantResolved {
	readonly requestId: string;
	readonly sessionId: string;
}
