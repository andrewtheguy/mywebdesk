import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/guac/ws": { target: "ws://localhost:18890", ws: true },
			"/api": { target: "http://localhost:18890" },
		},
	},
});
