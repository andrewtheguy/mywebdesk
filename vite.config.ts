import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const guacServerPort = process.env.GUAC_SERVER_PORT || "18890";

export default defineConfig({
	plugins: [react()],
	server: {
		allowedHosts: [".trycloudflare.com"],
		proxy: {
			"/guac/ws": { target: `ws://localhost:${guacServerPort}`, ws: true },
			"/api": { target: `http://localhost:${guacServerPort}` },
		},
	},
});
