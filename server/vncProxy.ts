import type { Server } from "node:http";
import net from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { getSessionTokenFromCookieHeader, isValidSession } from "./auth.js";
import type { VncTarget } from "./config.js";
import {
  createByteReader,
  HandshakeError,
  performClientHandshake,
  performServerHandshake,
} from "./rfbHandshake.js";
import {
  getActiveTargetName,
  registerSessionWebSocket,
  validateSessionId,
} from "./session.js";

interface VncProxyOptions {
  targets: VncTarget[];
}

const activeSockets = new Set<net.Socket>();
const activeWebSockets = new Set<WebSocket>();

const HANDSHAKE_TIMEOUT_MS = 10_000;

function toBuffer(data: unknown): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

// Byte pipe between the browser's RFB client (over WebSocket) and the VNC
// server's TCP socket. The proxy completes the RFB security phase on both
// legs itself (see rfbHandshake.ts) so the VNC password stays server-side;
// after that it relays bytes verbatim.
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
    // The session claim recorded which target profile this session dials.
    const target = options.targets.find(
      (t) => t.name === getActiveTargetName(),
    );
    if (!target) {
      ws.close(1011, "no-target");
      return;
    }

    activeWebSockets.add(ws);
    registerSessionWebSocket(ws);

    const tcp = net.createConnection({
      host: target.host,
      port: target.port,
    });
    tcp.setNoDelay(true);
    activeSockets.add(tcp);

    let piping = false;

    // Fail fast on unreachable/unresponsive targets. Covers TCP connect plus
    // the RFB security handshake — an established session is legitimately
    // idle when nothing on the remote screen changes.
    const handshakeTimer = setTimeout(() => {
      console.error(
        `VNC handshake timed out (${target.name}: ${target.host}:${target.port})`,
      );
      tcp.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1011, "vnc-unreachable");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // --- RFB security phase on both legs, then splice the streams ---

    const tcpReader = createByteReader((onChunk, onEnd) => {
      tcp.on("data", onChunk);
      tcp.on("close", onEnd);
      tcp.on("error", onEnd);
      return () => {
        tcp.off("data", onChunk);
        tcp.off("close", onEnd);
        tcp.off("error", onEnd);
      };
    });

    const wsReader = createByteReader((onChunk, onEnd) => {
      const onMessage = (data: unknown) => onChunk(toBuffer(data));
      ws.on("message", onMessage);
      ws.on("close", onEnd);
      ws.on("error", onEnd);
      return () => {
        ws.off("message", onMessage);
        ws.off("close", onEnd);
        ws.off("error", onEnd);
      };
    });

    Promise.all([
      performServerHandshake(
        tcpReader,
        (data) => {
          if (!tcp.destroyed) tcp.write(data);
        },
        target.password,
      ),
      performClientHandshake(wsReader, (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }),
    ])
      .then(() => {
        clearTimeout(handshakeTimer);
        // Hand over any bytes that arrived past the handshake, then pipe.
        // No awaits between detach and attach, so no events can slip by.
        const fromClient = wsReader.rest();
        const fromServer = tcpReader.rest();
        wsReader.detach();
        tcpReader.detach();
        attachPipe();
        if (fromClient.length > 0 && !tcp.destroyed) tcp.write(fromClient);
        if (fromServer.length > 0 && ws.readyState === ws.OPEN)
          ws.send(fromServer);
      })
      .catch((err: unknown) => {
        clearTimeout(handshakeTimer);
        wsReader.detach();
        tcpReader.detach();
        const message =
          err instanceof Error ? err.message : String(err ?? "unknown error");
        console.error("VNC handshake failed:", message);
        tcp.destroy();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close(
            1011,
            err instanceof HandshakeError
              ? "vnc-handshake-failed"
              : "vnc-unreachable",
          );
        }
      });

    // --- Post-handshake byte pipe ---

    // Manual pipe (Bun's `ws` shim does not implement createWebSocketStream).
    // Client→server traffic is tiny (input events), so only the TCP→WS
    // direction needs backpressure: pause the TCP socket while the WebSocket
    // send buffer is saturated.
    const WS_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
    const WS_BUFFER_LOW_WATER = 512 * 1024;
    let drainTimer: ReturnType<typeof setInterval> | null = null;

    function clearDrainTimer(): void {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    }

    function attachPipe(): void {
      piping = true;

      ws.on("message", (data) => {
        if (!tcp.destroyed) {
          tcp.write(toBuffer(data));
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
    }

    // --- Teardown (active from the start) ---

    tcp.on("error", (err) => {
      console.error("VNC TCP error:", err.message);
      if (
        piping &&
        (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
      ) {
        ws.close(1011, "vnc-unreachable");
      }
    });

    tcp.on("close", () => {
      clearDrainTimer();
      activeSockets.delete(tcp);
      // During the handshake the failure handler picks the close reason.
      if (piping && ws.readyState === ws.OPEN) {
        ws.close(1000);
      }
    });

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
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
