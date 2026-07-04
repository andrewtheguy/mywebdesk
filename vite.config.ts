import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const mywebdeskServerPort = process.env.MYWEBDESK_SERVER_PORT || "18890";

export default defineConfig({
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
      "/vnc/ws": { target: `ws://localhost:${mywebdeskServerPort}`, ws: true },
      "/api": { target: `http://localhost:${mywebdeskServerPort}` },
    },
  },
});
