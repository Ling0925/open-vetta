import type { ToolPathHost } from "../../shared/path-resolution.js";

export type WriteFileSnapshot = { readonly kind: "missing" } | { readonly kind: "content"; readonly bytes: Uint8Array };

export interface WriteOperations {
	readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
	readonly mkdir: (directory: string) => Promise<void>;
	/** Optional best-effort preview. Read at most maxBytes + 1 bytes; only report missing on a definite absence. */
	readonly readForDiff?: (absolutePath: string, maxBytes: number, signal: AbortSignal) => Promise<WriteFileSnapshot>;
}

export interface WritePathPolicy {
	readonly getRejectionReason: (absolutePath: string) => string | undefined;
}

export interface WriteToolOptions {
	readonly operations?: WriteOperations;
	readonly pathPolicy: WritePathPolicy;
	/** File paths must be resolved on the same host that performs the write. */
	readonly pathHost?: ToolPathHost;
}

export type WriteDiffStatus = "available" | "unavailable";
export type WriteDiffUnavailableReason = "not-supported" | "read-unavailable" | "too-large" | "non-text";

export interface WriteToolDetails {
	readonly path: string;
	readonly bytesWritten: number;
	readonly changeKind: "created" | "modified" | "unchanged" | "unknown";
	readonly diffStatus: WriteDiffStatus;
	/** An observed before-image, not a compare-and-swap or concurrent modification guarantee. */
	readonly diffBasis?: "pre-write-read";
	readonly diff?: string;
	readonly firstChangedLine?: number;
	readonly diffUnavailableReason?: WriteDiffUnavailableReason;
}
