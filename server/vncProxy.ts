import type { Server } from "node:http";
import net from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { getSessionTokenFromCookieHeader, isValidSession } from "./auth.js";
import { registerSessionWebSocket, validateSessionId } from "./session.js";

interface VncProxyOptions {
  vncHost: string;
  vncPort: number;
}

const activeSockets = new Set<net.Socket>();
const activeWebSockets = new Set<WebSocket>();

const CONNECT_TIMEOUT_MS = 10_000;

// Dumb byte pipe between the browser's RFB client (over WebSocket) and the
// VNC server's TCP socket. All protocol logic lives in the browser.
export function attachVncProxy(
  server: Server,
  options: VncProxyOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const upgradeUrl = req.url
      ? new URL(req.url, `http://${req.headers.host || "localhost"}`)
      : null;
    if (upgradeUrl?.pathname !== "/vnc/ws") {
      socket.destroy();
      return;
    }
    const cookieToken = getSessionTokenFromCookieHeader(req.headers.cookie);
    if (!cookieToken || !isValidSession(cookieToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = upgradeUrl.searchParams.get("SESSION_ID") ?? "";
    if (!validateSessionId(sessionId)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    activeWebSockets.add(ws);
    registerSessionWebSocket(ws);

    const tcp = net.createConnection({
      host: options.vncHost,
      port: options.vncPort,
    });
    tcp.setNoDelay(true);
    activeSockets.add(tcp);

    // Fail fast on unreachable/unresponsive targets. Only guards the connect
    // phase — an established RFB session is legitimately idle when nothing
    // on the remote screen changes.
    const connectTimer = setTimeout(() => {
      console.error(
        `VNC connect timed out (${options.vncHost}:${options.vncPort})`,
      );
      tcp.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1011, "vnc-unreachable");
      }
    }, CONNECT_TIMEOUT_MS);
    tcp.on("connect", () => clearTimeout(connectTimer));

    // Manual byte pipe (Bun's `ws` shim does not implement
    // createWebSocketStream). Client→server traffic is tiny (input events),
    // so only the TCP→WS direction needs backpressure: pause the TCP socket
    // while the WebSocket send buffer is saturated.
    const WS_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
    const WS_BUFFER_LOW_WATER = 512 * 1024;
    let drainTimer: ReturnType<typeof setInterval> | null = null;

    function clearDrainTimer(): void {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    }

    ws.on("message", (data) => {
      const chunk = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      if (!tcp.destroyed) {
        tcp.write(chunk);
      }
    });

    tcp.on("data", (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk);
      if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER && !drainTimer) {
        tcp.pause();
        drainTimer = setInterval(() => {
          if (
            ws.readyState !== ws.OPEN ||
            ws.bufferedAmount < WS_BUFFER_LOW_WATER
          ) {
            clearDrainTimer();
            tcp.resume();
          }
        }, 20);
      }
    });

    tcp.on("error", (err) => {
      console.error("VNC TCP error:", err.message);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1011, "vnc-unreachable");
      }
    });

    tcp.on("close", () => {
      clearTimeout(connectTimer);
      clearDrainTimer();
      activeSockets.delete(tcp);
      if (ws.readyState === ws.OPEN) {
        ws.close(1000);
      }
    });

    ws.on("close", () => {
      clearDrainTimer();
      activeWebSockets.delete(ws);
      tcp.destroy();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      tcp.destroy();
    });
  });

  return wss;
}

export function closeAll() {
  for (const ws of activeWebSockets) {
    ws.terminate();
  }
  activeWebSockets.clear();
  for (const s of activeSockets) {
    s.destroy();
  }
  activeSockets.clear();
}
