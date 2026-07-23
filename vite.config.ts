import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy target: read [server].port from remotex.toml so the Vite proxy
// follows the server config without a separate env var. Plain regex instead of
// a TOML parser — this config may run under Node, where Bun.TOML is missing.
function readRemotexServerPort(): string {
  try {
    const text = readFileSync(path.resolve(__dirname, "remotex.toml"), "utf-8");
    const serverSection = text.split(/^\[server\]/m)[1]?.split(/^\[/m)[0] ?? "";
    const match = serverSection.match(/^\s*port\s*=\s*(\d+)/m);
    if (match) return match[1];
  } catch {
    // No config file — fall through to the default.
  }
  return "18890";
}

const remotexServerPort = readRemotexServerPort();

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
