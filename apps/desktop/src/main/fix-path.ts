import { delimiter } from "node:path";
import { type BoundedProcessResult, runBoundedProcess } from "./bounded-process.js";
import { getAppLogger } from "./logger.js";

const log = getAppLogger("fix-path");

// 唯一标记,把 $PATH 从登录 shell 的输出里精确截出来,规避 profile 里的 banner/echo 污染。
const MARKER = "__VETTA_PATH_MARKER__";
const PATH_PROBE_TIMEOUT_MS = 5000;

export interface FixPathOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly runProcess?: (
		command: string,
		args: readonly string[],
		options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly stderr: "ignore" },
	) => Promise<BoundedProcessResult>;
}

/**
 * 修复 macOS/Linux GUI 进程的 PATH。
 *
 * 从 Finder/Dock 启动的 GUI 应用不会继承终端 shell 的 PATH,只拿到系统精简 PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin),不含 homebrew(/opt/homebrew/bin)等用户安装路径。
 * 而 coding-agent 的 bash 工具用的是 `bash -c`(非登录非交互),不会 source 任何
 * profile,也补不回这些路径,导致 brew 及一切 brew 安装的命令找不到。
 *
 * 这里异步运行一次用户登录交互 shell(`-ilc`,确保 .zprofile/.zshrc/.bash_profile 都被
 * source),解析出真实 PATH,把缺失的项**追加**到 process.env.PATH 末尾。
 *
 * 设计取舍:
 * - 追加而非前置:保留 RuntimeManager.applyEnv() 注入的托管运行时优先级,不让
 *   homebrew 的 node/python 抢在托管版前面。
 * - runtimes/manager.ts 在模块加载时、此次异步注入开始前已取得 SYSTEM_PATH_SNAPSHOT；
 *   那份快照仍只用于探测真正的系统运行时，不会把托管目录误判成系统安装。
 *
 * 幂等:重复调用安全(已存在的路径不会重复追加)。探测有 5 秒上限且失败安全，不阻断启动。
 */
export async function fixPath(options: FixPathOptions = {}): Promise<void> {
	// Windows GUI 进程能正常继承系统 PATH,无需修复。
	if ((options.platform ?? process.platform) === "win32") return;

	const env = options.env ?? process.env;
	const shell = env.SHELL || "/bin/zsh";
	try {
		const result = await (options.runProcess ?? runBoundedProcess)(
			shell,
			["-ilc", `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
			{
				env,
				timeoutMs: PATH_PROBE_TIMEOUT_MS,
				// 关掉 stdin,避免交互式 shell 阻塞等待输入；stderr 中的 profile 输出不参与解析。
				stderr: "ignore",
			},
		);
		if (result.exitCode !== 0 || !result.stdout) {
			log.warn("login shell PATH probe failed", {
				shell,
				status: result.exitCode,
				timedOut: result.timedOut,
				error: result.error?.message,
			});
			return;
		}
		const start = result.stdout.indexOf(MARKER);
		const end = result.stdout.indexOf(MARKER, start + MARKER.length);
		if (start === -1 || end === -1 || end <= start) return;
		const resolved = result.stdout.slice(start + MARKER.length, end).trim();
		if (!resolved) return;

		const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const existing = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
		const seen = new Set(existing);
		const appended: string[] = [];
		for (const path of resolved.split(delimiter)) {
			if (!path || seen.has(path)) continue;
			seen.add(path);
			appended.push(path);
		}
		if (appended.length === 0) return;

		env[pathKey] = [...existing, ...appended].join(delimiter);
		log.info("PATH fixed from login shell", { shell, added: appended });
	} catch (err) {
		log.warn("fixPath failed", err);
	}
}

/** Keep PATH-dependent startup behind the shared readiness promise without delaying the visible shell. */
export async function startAfterPathReady<T>(pathReady: Promise<void>, start: () => T | Promise<T>): Promise<T> {
	await pathReady;
	return await start();
}
