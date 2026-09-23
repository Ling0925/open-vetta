import type { IpcRenderer, IpcRendererEvent, WebUtils } from "electron";
import type { DesktopHostTransport, HostTransport, HostTransportEventListener } from "../shared/host-transport.js";

type ElectronHostListener = Parameters<IpcRenderer["on"]>[1];

export interface ElectronHostIpcRenderer {
	invoke: IpcRenderer["invoke"];
	send: IpcRenderer["send"];
	sendSync: IpcRenderer["sendSync"];
	on(channel: string, listener: ElectronHostListener): void;
	removeListener(channel: string, listener: ElectronHostListener): void;
}

export type ElectronHostWebUtils = Pick<WebUtils, "getPathForFile">;

type NativeListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

/** Adapt Electron's event emitter surface to the platform-neutral host contract. */
export function createElectronHostTransport(
	ipcRenderer: ElectronHostIpcRenderer,
	webUtils: ElectronHostWebUtils,
): DesktopHostTransport {
	const registered = new Map<string, Map<HostTransportEventListener, NativeListener[]>>();

	const ipc: HostTransport = {
		invoke: <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>,
		send: (channel: string, ...args: unknown[]) => {
			ipcRenderer.send(channel, ...args);
		},
		sendSync: <T>(channel: string, ...args: unknown[]) => ipcRenderer.sendSync(channel, ...args) as T,
		on: (channel: string, listener: HostTransportEventListener) => {
			const nativeListener: NativeListener = (event, ...args) => listener(event, ...args);
			const channelListeners = registered.get(channel) ?? new Map<HostTransportEventListener, NativeListener[]>();
			const listenerInstances = channelListeners.get(listener) ?? [];
			listenerInstances.push(nativeListener);
			channelListeners.set(listener, listenerInstances);
			registered.set(channel, channelListeners);
			ipcRenderer.on(channel, nativeListener);
		},
		removeListener: (channel: string, listener: HostTransportEventListener) => {
			const channelListeners = registered.get(channel);
			const listenerInstances = channelListeners?.get(listener);
			const nativeListener = listenerInstances?.pop();
			if (!nativeListener) return;
			ipcRenderer.removeListener(channel, nativeListener);
			if (listenerInstances && listenerInstances.length === 0) channelListeners?.delete(listener);
			if (channelListeners?.size === 0) registered.delete(channel);
		},
	};

	return {
		ipc,
		filePath: {
			getPathForFile: (file) => webUtils.getPathForFile(file),
		},
	};
}
