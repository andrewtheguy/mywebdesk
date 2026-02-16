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

export function evictSession(): void {
	for (const ws of sessionWebSockets) {
		ws.close(4001, "Session taken over");
	}
	sessionWebSockets.clear();
	activeSessionId = null;
}
