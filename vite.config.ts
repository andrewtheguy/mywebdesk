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
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/vnc/ws": { target: `ws://localhost:${remotexServerPort}`, ws: true },
      "/api": { target: `http://localhost:${remotexServerPort}` },
    },
  },
});
