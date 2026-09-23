import { useEffect, useState } from "react";
import type { WebAccessProjectSnapshot } from "../shared/web-access.js";
import { retryDelay, waitForRetry } from "./retry.js";
import { snapshot, WebAccessClientError, watch } from "./web-api.js";

export type ProjectSyncStatus = "loading" | "synced" | "offline" | "revoked";

/** 断线原因，只用来选文案；状态机本身对两种原因的处理一致（都重试）。 */
export type ProjectSyncReason = "network" | "server" | "revoked";

export interface ProjectSyncState {
	readonly status: ProjectSyncStatus;
	readonly forCsrf?: string;
	readonly snapshot?: WebAccessProjectSnapshot;
	readonly reason?: ProjectSyncReason;
}

export interface ProjectSyncOptions {
	/** 首次重试等待时间，之后指数退避并封顶 10 秒。 */
	readonly retryDelayMs?: number;
	/** 值变化时重新拉取完整快照（例如用户点了刷新），不需要重新认证。 */
	readonly restartKey?: number;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * 持续跟随宿主项目快照。
 *
 * 断线后自己重连，而不是停在「连接已断开，请刷新」：网页刷新会重新认证，但那要求用户
 * 手动操作，且刷新期间看不到任何状态。重连用的是同一个游标——服务端在游标对不上时
 * 直接返回完整快照，所以重试不会丢变更，也不会重复副作用（这一增量只有只读观察）。
 *
 * 授权失效（401）不重试：重试只会一直拿到 401，界面应当明确要求重新配对。
 */
export function useProjectSync(csrf: string | undefined, options: ProjectSyncOptions = {}): ProjectSyncState {
	const [state, setState] = useState<ProjectSyncState>({ status: "loading" });
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const restartKey = options.restartKey ?? 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: restartKey 是「重新同步时机」而非读取值
	useEffect(() => {
		if (!csrf) {
			setState({ status: "loading" });
			return;
		}
		const sessionCsrf = csrf;
		setState((current) => ({
			status: "loading",
			forCsrf: sessionCsrf,
			...(current.forCsrf === sessionCsrf && current.snapshot ? { snapshot: current.snapshot } : {}),
		}));
		const controller = new AbortController();
		let active = true;
		let cursor: number | undefined;
		let generation: string | undefined;
		let attempt = 0;

		void run();
		return () => {
			active = false;
			controller.abort();
		};

		async function run(): Promise<void> {
			while (active && !controller.signal.aborted) {
				try {
					if (cursor === undefined || generation === undefined) {
						const initial = await snapshot(sessionCsrf, controller.signal);
						if (!active || controller.signal.aborted) return;
						cursor = initial.cursor;
						generation = initial.generation;
						setState({ status: "synced", forCsrf: sessionCsrf, snapshot: initial });
					} else {
						const result = await watch(sessionCsrf, { cursor, generation }, controller.signal);
						if (!active || controller.signal.aborted) return;
						cursor = result.snapshot.cursor;
						generation = result.snapshot.generation;
						setState({ status: "synced", forCsrf: sessionCsrf, snapshot: result.snapshot });
					}
					attempt = 0;
				} catch (cause: unknown) {
					if (!active || controller.signal.aborted) return;
					if (cause instanceof WebAccessClientError && cause.status === 401) {
						setState({ status: "revoked", forCsrf: sessionCsrf, reason: "revoked" });
						return;
					}
					// 保留上一份快照继续显示，用户看到的是「旧数据 + 正在重连」，不是空列表。
					setState((current) => ({
						status: "offline",
						forCsrf: sessionCsrf,
						...(current.forCsrf === sessionCsrf && current.snapshot ? { snapshot: current.snapshot } : {}),
						reason: cause instanceof WebAccessClientError ? "server" : "network",
					}));
					const delay = retryDelay(attempt, retryDelayMs);
					attempt += 1;
					if (!(await waitForRetry(delay, controller.signal))) return;
				}
			}
		}
	}, [csrf, restartKey, retryDelayMs]);

	return state;
}
