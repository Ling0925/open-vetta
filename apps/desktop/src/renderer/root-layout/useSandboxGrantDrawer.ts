import type { SandboxPermissionDrawerState } from "@shared/store/ui-atoms";
import { useEffect } from "react";

/** Keeps the existing permission drawer correlated with server request lifetime. */
export function useSandboxGrantDrawer(setDrawer: (value: SandboxPermissionDrawerState | null) => void): void {
	useEffect(() => {
		type Request = Parameters<Parameters<typeof window.vetta.session.onSandboxGrantRequest>[0]>[0];
		const queue: Request[] = [];
		let current: Request | undefined;
		let mounted = true;
		const next = () => {
			current = queue.shift();
			const request = current;
			if (!request) {
				setDrawer(null);
				return;
			}
			const respond = (decision: "allow_once" | "allow_session" | "deny") => {
				if (!mounted || current !== request) return;
				// Keep the dialog until the host resolves it; transport failure does not grant permission.
				void window.vetta.session.respondToSandboxGrant(request.requestId, decision).catch(() => undefined);
			};
			setDrawer({
				requestId: request.requestId,
				runtimeId: request.sessionId,
				title: request.title,
				message: request.message,
				sensitive: request.sensitive,
				onConfirm: () => respond("allow_once"),
				onCancel: () => respond("deny"),
				onAllowSession: request.sensitive ? undefined : () => respond("allow_session"),
			});
		};
		const removeRequest = window.vetta.session.onSandboxGrantRequest((request) => {
			if (
				!mounted ||
				current?.requestId === request.requestId ||
				queue.some((item) => item.requestId === request.requestId)
			)
				return;
			queue.push(request);
			if (!current) next();
		});
		const removeResolved = window.vetta.session.onSandboxGrantResolved((event) => {
			if (!mounted) return;
			for (let i = queue.length - 1; i >= 0; i--) {
				if (queue[i].requestId === event.requestId && queue[i].sessionId === event.sessionId) queue.splice(i, 1);
			}
			if (current?.requestId === event.requestId && current.sessionId === event.sessionId) next();
		});
		return () => {
			mounted = false;
			current = undefined;
			queue.length = 0;
			removeRequest();
			removeResolved();
			setDrawer(null);
		};
	}, [setDrawer]);
}
