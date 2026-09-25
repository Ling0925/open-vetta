/**
 * 退出前的优雅清理（IM sidecar、运行时文件锁、本地 RPC、全局键盘监听…）。
 *
 * 更新安装必须先等待清理，再把终止时机交给 Squirrel.Mac，不能提前 app.exit()。
 * main.ts 注册主清理；按需创建的独占进程通过 participant 加入同一次等待。
 */
export type QuitCleanup = () => Promise<void>;
let cleanup: QuitCleanup | undefined;
let started = false;
let running: Promise<void> | undefined;
const participants = new Set<QuitCleanup>();

export function setQuitCleanup(fn: QuitCleanup): void { cleanup = fn; }
export function isQuitCleanupStarted(): boolean { return started; }
export function registerQuitCleanupParticipant(fn: QuitCleanup): () => void {
	if (started) throw new Error("Application shutdown has started");
	participants.add(fn); return () => participants.delete(fn);
}

/** Every caller waits for the same cleanup, including updater and repeated before-quit requests. */
export function runQuitCleanup(): Promise<void> {
	if (running) return running;
	started = true;
	let resolve!: () => void; let reject!: (error: unknown) => void;
	running = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
	const jobs = [...participants, ...(cleanup ? [cleanup] : [])].map(fn => {
		try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); }
	});
	void Promise.allSettled(jobs).then(results => {
		const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
		if (failures.length) reject(new AggregateError(failures, "Application cleanup failed")); else resolve();
	});
	return running;
}

/** 仅供测试重置模块级状态。 */
export function resetQuitCleanupForTest(): void {
	cleanup = undefined; started = false; running = undefined; participants.clear();
}
