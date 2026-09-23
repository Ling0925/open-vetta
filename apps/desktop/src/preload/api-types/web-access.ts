import type { WebAccessConfig, WebAccessPairResult, WebAccessState } from "../../shared/web-access.js";

export type { WebAccessConfig, WebAccessPairResult, WebAccessState } from "../../shared/web-access.js";

export interface DesktopWebAccessApi {
	getState(): Promise<WebAccessState>;
	configure(config: WebAccessConfig): Promise<WebAccessState>;
	enable(): Promise<WebAccessState>;
	disable(): Promise<WebAccessState>;
	pair(): Promise<WebAccessPairResult>;
	revoke(grantId?: string): Promise<WebAccessState>;
}
