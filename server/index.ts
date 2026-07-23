import type { Socket } from "node:net";
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
import { displayResizeEnabled, requestDisplayResize } from "./displayResize.js";
import { claimSession, hasActiveSession } from "./session.js";
import { attachVncProxy, closeAll } from "./vncProxy.js";

// Injected at compile time via `bun build --define`; falls back to "dev" when run
// directly (bun run dev/start).
declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";

// Print version and exit before touching config, so `remotex --version` works
// with no env set (install.sh uses this to smoke-test the downloaded binary).
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

initHtpasswd();

const app = express();
app.use(express.json());
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number.parseInt(
  isProduction
    ? process.env.PORT || process.env.REMOTEX_SERVER_PORT || "18890"
    : process.env.REMOTEX_SERVER_PORT || "18890",
  10,
);
const HOST = process.env.HOST || "127.0.0.1";

const VNC_HOST = process.env.VNC_HOST || "127.0.0.1";
const VNC_PORT = Number.parseInt(process.env.VNC_PORT || "5901", 10);
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";

const COOKIE_FLAGS = "HttpOnly; SameSite=Strict; Path=/";

// Secure cookies set over plain HTTP are silently dropped by Safari (even on
// localhost, unlike Chrome), so only add the flag when the request actually
// arrived over HTTPS — directly or via a TLS-terminating proxy/tunnel.
function cookieFlags(req: express.Request): string {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  return isHttps ? `${COOKIE_FLAGS}; Secure` : COOKIE_FLAGS;
}

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
    `${getSessionCookieName()}=${token}; ${cookieFlags(req)}`,
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
    `${getSessionCookieName()}=; ${cookieFlags(req)}; Max-Age=0`,
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
    host: VNC_HOST,
    port: VNC_PORT,
    remoteResize: displayResizeEnabled,
  });
});

// Out-of-band resize for servers without RFB SetDesktopSize support: the
// client posts its viewport target and the server switches the remote
// display mode over SSH (see displayResize.ts).
app.post("/api/app/resize", (req, res) => {
  if (!displayResizeEnabled) {
    res.status(501).json({ error: "resize_not_configured" });
    return;
  }
  const { width, height } =
    (req.body as { width?: number; height?: number } | undefined) ?? {};
  if (!requestDisplayResize(width, height)) {
    res.status(400).json({ error: "invalid_dimensions" });
    return;
  }
  res.json({ ok: true });
});

// The proxy is a dumb byte pipe, so the display size is reported by the
// client after each framebuffer resize instead of being sniffed server-side.
let reportedDisplaySize = { width: 0, height: 0 };

app.get("/api/app/display", (_req, res) => {
  res.json(reportedDisplaySize);
});

app.post("/api/app/display", (req, res) => {
  const { width, height } =
    (req.body as { width?: number; height?: number } | undefined) ?? {};
  if (
    typeof width === "number" &&
    Number.isFinite(width) &&
    typeof height === "number" &&
    Number.isFinite(height)
  ) {
    reportedDisplaySize = {
      width: Math.round(width),
      height: Math.round(height),
    };
  }
  res.json({ ok: true });
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

// Serve static frontend assets (production build). In the compiled binary these
// are embedded via `with { type: "file" }`, so nothing is read from cwd/dist.
if (isProduction) {
  const { embeddedAssets } = await import("./embeddedAssets.generated.js");
  const indexPath = embeddedAssets.get("/index.html");
  app.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }
    const assetPath = embeddedAssets.get(req.path);
    if (assetPath) {
      const file = Bun.file(assetPath);
      // Bun doesn't know the .webmanifest type; browsers require this exact one.
      const contentType = req.path.endsWith(".webmanifest")
        ? "application/manifest+json"
        : file.type || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      if (req.path.startsWith("/assets/")) {
        // Hashed, content-addressed bundles — safe to cache forever.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // Everything else at the root (sw.js, manifest, icons) must revalidate
        // so PWA updates propagate immediately.
        res.setHeader("Cache-Control", "no-cache");
      }
      res.send(Buffer.from(await file.arrayBuffer()));
      return;
    }
    if (req.path.startsWith("/api/")) {
      return next();
    }
    // SPA fallback
    if (indexPath) {
      const file = Bun.file(indexPath);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.send(Buffer.from(await file.arrayBuffer()));
      return;
    }
    next();
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`remotex ${VERSION} running on http://${HOST}:${PORT}`);
});

attachVncProxy(server, {
  vncHost: VNC_HOST,
  vncPort: VNC_PORT,
  vncPassword: VNC_PASSWORD,
});

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
