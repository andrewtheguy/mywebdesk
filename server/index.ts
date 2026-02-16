import express from "express";
import path from "node:path";
import { attachGuacProxy, closeAll } from "./guacProxy.js";

const app = express();
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
const VNC_HOST = process.env.VNC_HOST || "169.254.0.1";
const VNC_PORT = process.env.VNC_PORT || "5901";
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";
const MAX_HEIGHT = Number.parseInt(process.env.MAX_HEIGHT || "1200", 10);

app.get("/api/config", (_req, res) => {
	res.json({
		vncHost: VNC_HOST,
		vncPort: VNC_PORT,
		vncPassword: VNC_PASSWORD,
		maxHeight: MAX_HEIGHT,
	});
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

function shutdown() {
	if (isShuttingDown) return;
	isShuttingDown = true;

	console.log("Shutting down gracefully...");

	const forceExitTimeout = setTimeout(() => {
		console.error("Forced exit after timeout");
		process.exit(1);
	}, 10000);
	forceExitTimeout.unref();

	closeAll();

	if (!server.listening) {
		process.exit(0);
	}

	server.close((err) => {
		if (err) {
			console.error("Error closing server:", err);
		} else {
			console.log("Server closed");
		}
		process.exit(err ? 1 : 0);
	});
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
