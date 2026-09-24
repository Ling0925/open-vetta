import type { CodexTransport, JsonObject, TransportEvent } from "../../src/codex-app-server/types.js";
export class MemoryTransport implements CodexTransport {
	readonly sent: JsonObject[] = [];
	readonly listeners = new Set<(event: TransportEvent) => void>();
	closed = false;
	onSend?: (message: JsonObject) => void;
	subscribe(listener: (event: TransportEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async send(message: JsonObject) {
		if (this.closed)
			throw new Error("Transport closed");
		this.sent.push(structuredClone(message));
		if (message.method === "initialize")
			this.reply(message, { userAgent: "codex-test" });
		this.onSend?.(message);
	}
	async close() { this.closed = true; }
	reply(message: JsonObject, result: unknown) { this.message({ id: message.id, result }); }
	message(message: unknown) {
		for (const listener of [...this.listeners])
			listener({ type: "message", message });
	}
	failure() {
		for (const listener of [...this.listeners])
			listener({ type: "failure", error: new Error("EOF") });
	}
	notify(method: string, params: JsonObject) { this.message({ method, params }); }
	requests(method: string) { return this.sent.filter((frame) => frame.method === method); }
}
export function turn(id = "turn-1", status = "inProgress", items: JsonObject[] = []) { return { id, status, items, error: null }; }
export async function flush() {
	// Deterministic microtask boundary, not a timing-based wait for a condition.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
