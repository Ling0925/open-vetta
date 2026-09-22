import { powerMonitor } from "electron";
import { getAppLogger } from "../logger.js";
import {
	getPetWindow,
	sendPetCommandToWindow,
	setPetMousePollingSuspended,
	setPetWindowCreatedListener,
} from "../pet-window.js";
import { applyPetPlaybackIntent, playbackCommandForNewWindow } from "./pet-playback-policy.js";

const log = getAppLogger("pet-idle-guard");

/**
 * 系统锁屏或休眠时暂停桌宠视频解码与鼠标穿透轮询，解锁或唤醒后恢复。
 * 正常空闲状态不暂停桌宠后台活动。
 */
let started = false;
let paused = false;
let screenLocked = false;
let systemSuspended = false;

function setPlayback(playing: boolean): void {
	const result = applyPetPlaybackIntent({
		paused,
		playing,
		windowOpen: Boolean(getPetWindow()),
	});
	setPetMousePollingSuspended(!playing);
	paused = result.paused;
	if (result.sendPlaying === undefined) return;
	sendPetCommandToWindow({ type: "set-playback", playing: result.sendPlaying });
	log.info(result.sendPlaying ? "resume" : "pause");
}

function syncPlayback(): void {
	setPlayback(!screenLocked && !systemSuspended);
}

/** 应用启动时调用一次：挂系统锁屏与休眠事件，据此暂停/恢复桌宠后台活动。 */
export function startPetIdleGuard(): void {
	if (started) return;
	started = true;
	setPetWindowCreatedListener(() => {
		sendPetCommandToWindow(playbackCommandForNewWindow(paused));
	});
	powerMonitor.on("lock-screen", () => {
		screenLocked = true;
		syncPlayback();
	});
	powerMonitor.on("suspend", () => {
		systemSuspended = true;
		syncPlayback();
	});
	powerMonitor.on("unlock-screen", () => {
		screenLocked = false;
		syncPlayback();
	});
	powerMonitor.on("resume", () => {
		systemSuspended = false;
		syncPlayback();
	});
	// 先订阅再读取当前状态，补齐守卫延后启动前已经发生且不会重放的锁屏事件。
	screenLocked = powerMonitor.getSystemIdleState(1) === "locked";
	syncPlayback();
}
