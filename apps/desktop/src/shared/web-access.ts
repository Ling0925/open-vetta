export const WEB_ACCESS_CHANNELS = {
	GET_STATE: "vetta:web-access:get-state",
	CONFIGURE: "vetta:web-access:configure",
	ENABLE: "vetta:web-access:enable",
	DISABLE: "vetta:web-access:disable",
	PAIR: "vetta:web-access:pair",
	REVOKE: "vetta:web-access:revoke",
} as const;

export interface WebAccessConfig {
	readonly origin: string;
	readonly port: number;
}

export type WebAccessStatus = "disabled" | "starting" | "enabled" | "error";

export interface WebAccessGrantInfo {
	readonly id: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface WebAccessState {
	readonly status: WebAccessStatus;
	readonly config?: WebAccessConfig;
	readonly generation: number;
	readonly grants: readonly WebAccessGrantInfo[];
	readonly pairingExpiresAt?: number;
	readonly error?: string;
}

export interface WebAccessPairResult {
	readonly webUrl: string;
	readonly code: string;
	readonly expiresAt: number;
}

export interface WebAccessProjectEntry {
	readonly path: string;
	readonly name?: string;
}

export interface WebAccessProjectSnapshot {
	readonly generation: string;
	readonly cursor: number;
	readonly projects: readonly WebAccessProjectEntry[];
	readonly archivedProjects: readonly WebAccessProjectEntry[];
}

export interface WebAccessWatchRequest {
	readonly generation?: string;
	readonly cursor?: number;
	readonly waitMs?: number;
}

export interface WebAccessWatchResponse {
	readonly changed: boolean;
	readonly snapshot: WebAccessProjectSnapshot;
}
