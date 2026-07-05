import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const remotexServerPort = process.env.REMOTEX_SERVER_PORT || "18890";

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      // Vendored fork of noVNC 1.7.0 (see src/vendor/novnc/ORIGIN.md). The
      // alias keeps specifiers non-relative so src/novnc.d.ts can type them.
      "@novnc-core": path.resolve(__dirname, "src/vendor/novnc/core"),
    },
  },
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/vnc/ws": { target: `ws://localhost:${remotexServerPort}`, ws: true },
      "/api": { target: `http://localhost:${remotexServerPort}` },
    },
  },
});
