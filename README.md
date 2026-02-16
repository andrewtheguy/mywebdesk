# guac-vnc

Minimal, mobile-friendly VNC viewer using `guacamole-common-js` with a custom UI.

## Pain points solved

- **Visible menu toggle** — FAB button always visible (no Ctrl+Alt+Shift or swipe needed)
- **Direct tap-and-drag** — touchstart immediately sends mousedown (no double-tap gesture)
- **Smart sizing** — uses VNC framebuffer size as minimum, with max height cap

## Architecture

```
Browser (Vite + React + guacamole-common-js)
    ↓ WebSocket (/guac/ws)
Express + ws (WebSocket-to-TCP bridge, port 18890)
    ↓ Raw TCP (Guacamole protocol)
guacd (port 14822)
    ↓ VNC protocol
TigerVNC (port 5901)
```

## Development

```bash
cp .env.example .env   # edit connection settings as needed
bun install
bun run dev
```

Open http://localhost:5173 — Vite proxies `/guac/ws` and `/api` to the Express server on `GUAC_SERVER_PORT` (default `18890`).

## Production

```bash
bun run build
bun run start
```

Serves the built frontend from `dist/` on port 18890.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GUAC_SERVER_PORT` | `18890` | Dev server listen port (also used by Vite proxy target) |
| `PORT` | `18890` | Production server listen port override |
| `HOST` | `127.0.0.1` | Server bind address |
| `GUACD_HOST` | `127.0.0.1` | guacd hostname |
| `GUACD_PORT` | `14822` | guacd port |
| `VNC_HOST` | `169.254.0.1` | VNC server hostname |
| `VNC_PORT` | `5901` | VNC server port |
| `VNC_PASSWORD` | *(empty)* | VNC password |
| `MAX_HEIGHT` | `1200` | Max resolution height sent to VNC |
