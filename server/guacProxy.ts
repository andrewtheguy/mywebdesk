import type { Server } from "node:http";
import net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

interface GuacProxyOptions {
	guacdHost: string;
	guacdPort: number;
}

const activeSockets = new Set<net.Socket>();
const activeWebSockets = new Set<WebSocket>();

export function attachGuacProxy(
	server: Server,
	options: GuacProxyOptions,
): WebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req, socket, head) => {
		if (req.url !== "/guac/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	wss.on("connection", (ws) => {
		activeWebSockets.add(ws);

		const tcp = net.createConnection(
			{ host: options.guacdHost, port: options.guacdPort },
			() => {
				console.log("Connected to guacd");
			},
		);

		activeSockets.add(tcp);

		tcp.on("data", (data) => {
			if (ws.readyState === ws.OPEN) {
				ws.send(data.toString("utf-8"));
			}
		});

		tcp.on("error", (err) => {
			console.error("guacd TCP error:", err.message);
			ws.close();
		});

		tcp.on("close", () => {
			activeSockets.delete(tcp);
			ws.close();
		});

		ws.on("message", (data) => {
			if (!tcp.destroyed) {
				tcp.write(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer));
			}
		});

		ws.on("close", () => {
			activeWebSockets.delete(ws);
			if (!tcp.destroyed) {
				tcp.destroy();
			}
		});

		ws.on("error", (err) => {
			console.error("WebSocket error:", err.message);
			if (!tcp.destroyed) {
				tcp.destroy();
			}
		});
	});

	return wss;
}

export function closeAll() {
	for (const ws of activeWebSockets) {
		ws.close();
	}
	activeWebSockets.clear();
	for (const s of activeSockets) {
		s.destroy();
	}
	activeSockets.clear();
}
