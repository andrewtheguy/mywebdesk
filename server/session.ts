import type { WebSocket } from "ws";

let activeSessionId: string | null = null;
const sessionWebSockets = new Set<WebSocket>();

export function hasActiveSession(): boolean {
	return activeSessionId !== null;
}

export function claimSession(force: boolean): string {
	if (activeSessionId !== null) {
		if (!force) {
			throw new Error("A session is already active");
		}
		evictSession();
	}
	activeSessionId = crypto.randomUUID();
	return activeSessionId;
}

export function validateSessionId(id: string): boolean {
	return id === activeSessionId;
}

export function registerSessionWebSocket(ws: WebSocket): void {
	sessionWebSockets.add(ws);
	ws.on("close", () => {
		sessionWebSockets.delete(ws);
	});
}

const EVICT_FORCE_CLOSE_MS = 2000;

export function evictSession(): void {
	for (const ws of sessionWebSockets) {
		ws.close(4001, "Session taken over");
		const timer = setTimeout(() => {
			if (ws.readyState !== ws.CLOSED) {
				ws.terminate();
			}
		}, EVICT_FORCE_CLOSE_MS);
		timer.unref();
		ws.once("close", () => clearTimeout(timer));
	}
	sessionWebSockets.clear();
	activeSessionId = null;
}
