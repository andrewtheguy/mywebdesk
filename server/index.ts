import type { Socket } from "node:net";
import path from "node:path";
import express from "express";
import {
  createSession,
  getSessionCookieName,
  getSessionTokenFromCookieHeader,
  initHtpasswd,
  invalidateSession,
  isValidSession,
  verifyCredentials,
} from "./auth.js";
import { attachGuacProxy, closeAll, getVncDisplaySize } from "./guacProxy.js";
import { claimSession, hasActiveSession } from "./session.js";

initHtpasswd();

const app = express();
app.use(express.json());
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number.parseInt(
  isProduction
    ? process.env.PORT || process.env.GUAC_SERVER_PORT || "18890"
    : process.env.GUAC_SERVER_PORT || "18890",
  10,
);
const HOST = process.env.HOST || "127.0.0.1";

const GUACD_HOST = process.env.GUACD_HOST || "127.0.0.1";
const GUACD_PORT = Number.parseInt(process.env.GUACD_PORT || "14822", 10);
const REMOTE_PROTOCOL = process.env.REMOTE_PROTOCOL === "rdp" ? "rdp" : "vnc";
const VNC_HOST = process.env.VNC_HOST || "127.0.0.1";
const VNC_PORT = process.env.VNC_PORT || "5901";
const RDP_HOST = process.env.RDP_HOST || "127.0.0.1";
const RDP_PORT = process.env.RDP_PORT || "3389";

const COOKIE_FLAGS = "HttpOnly; SameSite=Strict; Path=/; Secure";

// --- Public auth routes ---

app.post("/api/auth/login", async (req, res) => {
  const { username, password } =
    (req.body as { username?: string; password?: string } | undefined) ?? {};
  if (
    !username ||
    !password ||
    !(await verifyCredentials(username, password))
  ) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = createSession(username);
  res.setHeader(
    "Set-Cookie",
    `${getSessionCookieName()}=${token}; ${COOKIE_FLAGS}`,
  );
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getSessionTokenFromCookieHeader(req.headers.cookie);
  if (token) {
    invalidateSession(token);
  }
  res.setHeader(
    "Set-Cookie",
    `${getSessionCookieName()}=; ${COOKIE_FLAGS}; Max-Age=0`,
  );
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  const token = getSessionTokenFromCookieHeader(req.headers.cookie);
  const authenticated = !!token && isValidSession(token);
  res.json({ authenticated });
});

// --- Auth middleware for /api/app ---

app.use("/api/app", (req, res, next) => {
  const token = getSessionTokenFromCookieHeader(req.headers.cookie);
  if (!token || !isValidSession(token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// --- Authenticated app routes ---

app.get("/api/app/config", (_req, res) => {
  res.json({
    protocol: REMOTE_PROTOCOL,
    host: REMOTE_PROTOCOL === "rdp" ? RDP_HOST : VNC_HOST,
    port: REMOTE_PROTOCOL === "rdp" ? RDP_PORT : VNC_PORT,
  });
});

app.get("/api/app/display", (_req, res) => {
  res.json(getVncDisplaySize());
});

app.get("/api/app/session", (_req, res) => {
  res.json({ active: hasActiveSession() });
});

app.post("/api/app/session", (req, res) => {
  const force = !!(req.body as { force?: boolean } | undefined)?.force;
  if (!force && hasActiveSession()) {
    res.status(409).json({ error: "active_session" });
    return;
  }
  const sessionId = claimSession(force);
  res.json({ sessionId });
});

// Serve static frontend assets (production build)
if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(process.cwd(), "dist");
  app.use(express.static(distPath));

  // SPA fallback
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      return next();
    }
    return res.sendFile(path.join(distPath, "index.html"));
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

attachGuacProxy(server, { guacdHost: GUACD_HOST, guacdPort: GUACD_PORT });

const activeHttpSockets = new Set<Socket>();
server.on("connection", (socket) => {
  activeHttpSockets.add(socket);
  socket.on("close", () => {
    activeHttpSockets.delete(socket);
  });
});

// Handle server errors
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Error: Port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});

// Graceful shutdown
let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    console.error(`Received ${signal} again, forcing exit`);
    process.exit(130);
  }
  isShuttingDown = true;

  console.log(`Shutting down gracefully (${signal})...`);

  const forceExitTimeout = setTimeout(() => {
    console.error("Forced exit after timeout");
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  // Close proxy websocket/tcp links first so ws sessions do not block server.close().
  closeAll();

  if (!server.listening) {
    process.exit(0);
  }

  const closableServer = server as typeof server & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };

  try {
    server.close((err) => {
      if (err) {
        console.error("Error closing server:", err);
      } else {
        console.log("Server closed");
      }
      process.exit(err ? 1 : 0);
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ERR_SERVER_NOT_RUNNING") {
      console.log("Server already stopped");
      process.exit(0);
    }
    console.error("Error closing server:", err);
    process.exit(1);
  }

  // Best effort immediate closure of lingering keep-alive sockets.
  try {
    closableServer.closeIdleConnections?.();
    closableServer.closeAllConnections?.();
  } catch (err) {
    console.error("Error closing lingering HTTP connections:", err);
  }

  // Fallback: force-destroy tracked sockets if graceful close did not drain quickly.
  const destroyLingeringSocketsTimeout = setTimeout(() => {
    if (activeHttpSockets.size === 0) return;
    for (const socket of activeHttpSockets) {
      socket.destroy();
    }
    activeHttpSockets.clear();
  }, 1200);
  destroyLingeringSocketsTimeout.unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
