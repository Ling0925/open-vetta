import { type IpcMainInvokeEvent, ipcMain, type WebContents } from "electron";
import { WEB_ACCESS_CHANNELS } from "../../shared/web-access.js";
import type { DesktopWebAccessService } from "../web-access/web-access-service.js";

export function registerWebAccessIpc(webContents: WebContents, service: DesktopWebAccessService): () => void {
	const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
		const senderFrame = event.senderFrame;
		if (
			event.sender !== webContents ||
			event.sender.isDestroyed() ||
			!senderFrame ||
			senderFrame !== senderFrame.top ||
			senderFrame !== event.sender.mainFrame ||
			!isTrustedDesktopRendererUrl(event.sender.getURL())
		) {
			throw new Error("Unauthorized Web access management sender");
		}
	};

	ipcMain.handle(WEB_ACCESS_CHANNELS.GET_STATE, (event) => {
		assertTrustedSender(event);
		return service.getState();
	});
	ipcMain.handle(WEB_ACCESS_CHANNELS.CONFIGURE, (event, input: unknown) => {
		assertTrustedSender(event);
		return service.configure(input);
	});
	ipcMain.handle(WEB_ACCESS_CHANNELS.ENABLE, (event) => {
		assertTrustedSender(event);
		return service.enable();
	});
	ipcMain.handle(WEB_ACCESS_CHANNELS.DISABLE, (event) => {
		assertTrustedSender(event);
		return service.disable();
	});
	ipcMain.handle(WEB_ACCESS_CHANNELS.PAIR, (event) => {
		assertTrustedSender(event);
		return service.pair();
	});
	ipcMain.handle(WEB_ACCESS_CHANNELS.REVOKE, (event, grantId: unknown) => {
		assertTrustedSender(event);
		return service.revoke(typeof grantId === "string" ? grantId : undefined);
	});

	return () => {
		for (const channel of Object.values(WEB_ACCESS_CHANNELS)) ipcMain.removeHandler(channel);
	};
}

export function isTrustedDesktopRendererUrl(url: string): boolean {
	const developmentUrl = process.env.VETTA_DESKTOP_DEV_URL;
	if (developmentUrl) {
		try {
			const expected = new URL(developmentUrl);
			const actual = new URL(url);
			return actual.origin === expected.origin && actual.pathname.startsWith(expected.pathname.replace(/\/$/, ""));
		} catch {
			return false;
		}
	}
	try {
		const actual = new URL(url);
		return actual.protocol === "file:" && actual.pathname.endsWith("/renderer/index.html");
	} catch {
		return false;
	}
}
