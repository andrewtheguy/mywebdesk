# guac-vnc

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

Minimal, mobile-friendly VNC viewer using `guacamole-common-js` with a custom UI.

## Pain points solved

- **Visible menu toggle** — FAB button always visible (no Ctrl+Alt+Shift or swipe needed)
- **Consistent touch controls** — one-finger tap: left-click at cursor; hard-press: hold left-click; second-finger directional drag: move cursor while hold-drag is active; two-finger tap: right-click; two-finger pinch: zoom; two-finger drag: pan when not in hold-drag mode; three-finger swipe: scroll (vertical and horizontal via Shift+Wheel emulation)
- **Smart sizing** — follows viewport/container size, min-clamped to native VNC resolution

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
| `SITE_PASSWD` | *(required)* | Base64-encoded `username:bcrypt_hash` (see below) |
| `VNC_PASSWORD` | | VNC server password |
| `GUAC_SERVER_PORT` | `18890` | Dev server listen port (also used by Vite proxy target) |
| `PORT` | `18890` | Production server listen port override |
| `HOST` | `127.0.0.1` | Server bind address |
| `GUACD_HOST` | `127.0.0.1` | guacd hostname |
| `GUACD_PORT` | `14822` | guacd port |
| `VNC_HOST` | `169.254.0.1` | VNC server hostname |
| `VNC_PORT` | `5901` | VNC server port |
| `DEBUG_GUAC_PROXY` | `0` | Enable guac proxy debug logs when set to `1` |

`SITE_PASSWD` is required — the server will refuse to start without it. Generate a credential and add it to your `.env`:

```bash
bun server/gen-htpasswd.ts admin
# outputs: SITE_PASSWD=YWRtaW46JDJiJDEwJC4uLg==
```

The output is a ready-to-paste `.env` line (base64-encoded `username:bcrypt_hash`, no escaping needed).

## Browser requirements

Requires the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (`crypto.subtle`). This is available in all modern browsers when served over HTTPS or localhost. The app will refuse to load on unsupported browsers.
