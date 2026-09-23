export type HostTransportEventListener = (event: unknown, ...args: unknown[]) => void;

/**
 * Narrow transport contract shared by Electron preload and browser adapters.
 * It intentionally models IPC-like request/event semantics without importing Electron.
 */
export interface HostTransport {
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	send(channel: string, ...args: unknown[]): void;
	sendSync<T>(channel: string, ...args: unknown[]): T;
	on(channel: string, listener: HostTransportEventListener): void;
	removeListener(channel: string, listener: HostTransportEventListener): void;
}

/** File capabilities needed by APIs that accept browser File objects. */
export interface HostFilePathAdapter {
	getPathForFile(file: File): string;
}

export interface DesktopHostTransport {
	readonly ipc: HostTransport;
	readonly filePath: HostFilePathAdapter;
}
