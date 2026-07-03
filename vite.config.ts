import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const guacServerPort = process.env.GUAC_SERVER_PORT || "18890";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @novnc/novnc only exports core/rfb.js; alias past the exports map for
      // deep imports (keyboard handling).
      "@novnc-core": path.resolve(__dirname, "node_modules/@novnc/novnc/core"),
    },
  },
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/vnc/ws": { target: `ws://localhost:${guacServerPort}`, ws: true },
      "/api": { target: `http://localhost:${guacServerPort}` },
    },
  },
});
