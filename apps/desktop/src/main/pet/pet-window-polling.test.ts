import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PET_MOUSE_POLL_FAR_MS, PET_MOUSE_POLL_NEAR_MS } from "./pet-mouse-poll.js";

const electronFake = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	type Bounds = { x: number; y: number; width: number; height: number };
	type SystemIdleState = "active" | "idle" | "locked" | "unknown";

	class FakeEmitter {
		private readonly listeners = new Map<string, Set<Listener>>();

		on(event: string, listener: Listener): this {
			const eventListeners = this.listeners.get(event) ?? new Set<Listener>();
			eventListeners.add(listener);
			this.listeners.set(event, eventListeners);
			return this;
		}

		off(event: string, listener: Listener): this {
			this.listeners.get(event)?.delete(listener);
			return this;
		}

		emit(event: string, ...args: unknown[]): void {
			for (const listener of this.listeners.get(event) ?? []) listener(...args);
		}

		removeAllListeners(): void {
			this.listeners.clear();
		}
	}

	class FakeWebContents extends FakeEmitter {
		private destroyed = false;
		private url = "";
		readonly send = vi.fn();
		readonly openDevTools = vi.fn();
		readonly setWindowOpenHandler = vi.fn();

		isDestroyed(): boolean {
			return this.destroyed;
		}

		getURL(): string {
			return this.url;
		}

		setURL(url: string): void {
			this.url = url;
		}

		destroy(): void {
			this.destroyed = true;
		}
	}

	const windows: FakeBrowserWindow[] = [];

	class FakeBrowserWindow extends FakeEmitter {
		private bounds: Bounds;
		private destroyed = false;
		private visible = false;
		private alwaysOnTop = true;
		readonly webContents = new FakeWebContents();
		readonly getBounds = vi.fn(() => ({ ...this.bounds }));
		readonly setIgnoreMouseEvents = vi.fn();
		readonly setVisibleOnAllWorkspaces = vi.fn();

		constructor(options: Partial<Bounds>) {
			super();
			this.bounds = {
				x: options.x ?? 0,
				y: options.y ?? 0,
				width: options.width ?? 220,
				height: options.height ?? 220,
			};
			windows.push(this);
		}

		isDestroyed(): boolean {
			return this.destroyed;
		}

		isVisible(): boolean {
			return this.visible;
		}

		showInactive(): void {
			this.visible = true;
		}

		setBounds(bounds: Bounds): void {
			this.bounds = { ...bounds };
		}

		setAlwaysOnTop(alwaysOnTop: boolean): void {
			this.alwaysOnTop = alwaysOnTop;
		}

		isAlwaysOnTop(): boolean {
			return this.alwaysOnTop;
		}

		async loadURL(url: string): Promise<void> {
			this.webContents.setURL(url);
		}

		destroy(): void {
			if (this.destroyed) return;
			this.destroyed = true;
			this.webContents.destroy();
			this.emit("closed");
		}
	}

	const cursor = { x: 0, y: 0 };
	const screen = new FakeEmitter() as FakeEmitter & {
		getCursorScreenPoint: ReturnType<typeof vi.fn>;
		getDisplayNearestPoint: ReturnType<typeof vi.fn>;
		getPrimaryDisplay: ReturnType<typeof vi.fn>;
	};
	screen.getCursorScreenPoint = vi.fn(() => ({ ...cursor }));
	screen.getPrimaryDisplay = vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
	screen.getDisplayNearestPoint = vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
	let systemIdleState: SystemIdleState = "active";
	const powerMonitor = new FakeEmitter() as FakeEmitter & {
		getSystemIdleState: ReturnType<typeof vi.fn>;
	};
	powerMonitor.getSystemIdleState = vi.fn(() => systemIdleState);

	return {
		BrowserWindow: FakeBrowserWindow,
		Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
		app: { getAppPath: vi.fn(() => process.cwd()), isPackaged: false },
		cursor,
		powerMonitor,
		screen,
		setSystemIdleState(state: SystemIdleState): void {
			systemIdleState = state;
		},
		windows,
		reset(): void {
			windows.length = 0;
			cursor.x = 0;
			cursor.y = 0;
			screen.removeAllListeners();
			powerMonitor.removeAllListeners();
			systemIdleState = "active";
			vi.clearAllMocks();
		},
	};
});

vi.mock("electron", () => ({
	app: electronFake.app,
	BrowserWindow: electronFake.BrowserWindow,
	Menu: electronFake.Menu,
	powerMonitor: electronFake.powerMonitor,
	screen: electronFake.screen,
}));

vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../ipc/fs.js", () => ({ allowProjectRoot: vi.fn() }));
vi.mock("../logger.js", () => ({
	getAppLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../media-protocol.js", () => ({ MEDIA_PROTOCOL_SCHEME: "vetta-media" }));
vi.mock("../pet-config-store.js", () => ({
	readPetConfigSync: () => ({
		schemaVersion: 4,
		enabled: true,
		autoMode: true,
		alwaysOnTop: true,
		size: 220,
		debugFrame: false,
		bubbleStyleId: "plain",
		videoScale: 1,
		videoBaseSizeByAction: {},
	}),
	writePetConfig: vi.fn(async () => undefined),
}));
vi.mock("../window-manager.js", () => ({ iconPath: { darwin: "", linux: "", win32: "" } }));

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	electronFake.reset();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function createPollingPet() {
	const pet = await import("../pet-window.js");
	const win = pet.initializePetWindow();
	if (!win) throw new Error("expected the default-enabled pet window to be created");
	const fakeWin = electronFake.windows.at(-1);
	if (!fakeWin) throw new Error("expected a fake BrowserWindow");
	const bounds = fakeWin.getBounds();
	electronFake.cursor.x = bounds.x + 20;
	electronFake.cursor.y = bounds.y + 20;
	pet.setPetVideoHitbox({ x: 10, y: 10, width: 100, height: 100 });
	return { fakeWin, pet };
}

describe("pet mouse passthrough polling", () => {
	it("reuses one native snapshot per near, far, and dragging poll", async () => {
		const { fakeWin, pet } = await createPollingPet();
		expect(vi.getTimerCount()).toBe(1);
		expect(fakeWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();
		vi.advanceTimersByTime(PET_MOUSE_POLL_NEAR_MS - 1);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(fakeWin.getBounds).toHaveBeenCalledTimes(1);

		electronFake.cursor.x = 0;
		electronFake.cursor.y = 0;
		vi.advanceTimersByTime(PET_MOUSE_POLL_NEAR_MS);
		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();
		vi.advanceTimersByTime(PET_MOUSE_POLL_FAR_MS - 1);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(fakeWin.getBounds).toHaveBeenCalledTimes(1);
		expect(fakeWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);

		pet.beginPetWindowMove();
		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();
		vi.advanceTimersByTime(PET_MOUSE_POLL_FAR_MS);
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(fakeWin.getBounds).toHaveBeenCalledTimes(1);
		expect(fakeWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();
		vi.advanceTimersByTime(PET_MOUSE_POLL_NEAR_MS - 1);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(fakeWin.getBounds).toHaveBeenCalledTimes(1);

		electronFake.cursor.x = fakeWin.getBounds().x + 20;
		electronFake.cursor.y = fakeWin.getBounds().y + 20;
		pet.endPetWindowMove();
		expect(fakeWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
		pet.setPetVideoHitbox(undefined);
		expect(fakeWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("detects a lock that happened before guard startup and restores one timer after unlock", async () => {
		const { fakeWin } = await createPollingPet();
		expect(vi.getTimerCount()).toBe(1);
		electronFake.setSystemIdleState("locked");
		electronFake.powerMonitor.emit("lock-screen");
		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();

		const idleGuard = await import("./pet-idle-guard.js");
		idleGuard.startPetIdleGuard();

		expect(electronFake.powerMonitor.getSystemIdleState).toHaveBeenCalledWith(1);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(PET_MOUSE_POLL_FAR_MS * 5);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(fakeWin.getBounds).not.toHaveBeenCalled();

		electronFake.setSystemIdleState("active");
		electronFake.powerMonitor.emit("unlock-screen");
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(fakeWin.getBounds).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();
		electronFake.powerMonitor.emit("unlock-screen");
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(fakeWin.getBounds).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
	});
	it("stays stopped across overlapping lock and suspend, then resumes one timer and cleans up", async () => {
		const { fakeWin, pet } = await createPollingPet();
		const idleGuard = await import("./pet-idle-guard.js");
		idleGuard.startPetIdleGuard();
		electronFake.screen.getCursorScreenPoint.mockClear();
		fakeWin.getBounds.mockClear();

		electronFake.powerMonitor.emit("lock-screen");
		electronFake.powerMonitor.emit("lock-screen");
		electronFake.powerMonitor.emit("suspend");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(PET_MOUSE_POLL_FAR_MS * 5);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(fakeWin.getBounds).not.toHaveBeenCalled();

		pet.applyPetConfig({ ...pet.getPetConfig(), enabled: false });
		expect(fakeWin.isDestroyed()).toBe(true);
		pet.applyPetConfig({ ...pet.getPetConfig(), enabled: true });
		const recreatedWin = electronFake.windows.at(-1);
		if (!recreatedWin || recreatedWin === fakeWin) throw new Error("expected the pet window to be recreated");
		const recreatedBounds = recreatedWin.getBounds();
		electronFake.cursor.x = recreatedBounds.x + 20;
		electronFake.cursor.y = recreatedBounds.y + 20;
		electronFake.screen.getCursorScreenPoint.mockClear();
		recreatedWin.getBounds.mockClear();
		pet.setPetVideoHitbox({ x: 10, y: 10, width: 100, height: 100 });
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(recreatedWin.getBounds).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		electronFake.powerMonitor.emit("unlock-screen");
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		electronFake.powerMonitor.emit("resume");
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(recreatedWin.getBounds).toHaveBeenCalledTimes(1);
		expect(recreatedWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
		expect(vi.getTimerCount()).toBe(1);

		electronFake.screen.getCursorScreenPoint.mockClear();
		recreatedWin.getBounds.mockClear();
		electronFake.powerMonitor.emit("resume");
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(recreatedWin.getBounds).not.toHaveBeenCalled();

		electronFake.powerMonitor.emit("lock-screen");
		electronFake.powerMonitor.emit("suspend");
		electronFake.screen.getCursorScreenPoint.mockClear();
		recreatedWin.getBounds.mockClear();
		electronFake.powerMonitor.emit("resume");
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(recreatedWin.getBounds).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		electronFake.powerMonitor.emit("unlock-screen");
		expect(electronFake.screen.getCursorScreenPoint).toHaveBeenCalledTimes(1);
		expect(recreatedWin.getBounds).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		electronFake.screen.getCursorScreenPoint.mockClear();
		recreatedWin.getBounds.mockClear();

		pet.applyPetConfig({ ...pet.getPetConfig(), enabled: false });
		expect(recreatedWin.isDestroyed()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(PET_MOUSE_POLL_FAR_MS * 5);
		expect(electronFake.screen.getCursorScreenPoint).not.toHaveBeenCalled();
		expect(recreatedWin.getBounds).not.toHaveBeenCalled();
	});
});
