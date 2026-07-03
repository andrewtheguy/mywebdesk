# guac-vnc

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

Minimal, mobile-friendly VNC viewer with true HiDPI/Retina support, using `@novnc/novnc` for the RFB protocol with a custom UI.

## Pain points solved

- **True HiDPI/Retina** — the remote desktop is resized to exactly `viewport × devicePixelRatio` and rendered 1:1 in device pixels (see below)
- **Visible menu toggle** — FAB button always visible (no Ctrl+Alt+Shift or swipe needed)
- **Consistent touch controls** — one-finger tap: left-click at cursor; hard-press: hold left-click; second-finger directional drag: move cursor while hold-drag is active; two-finger tap: right-click; two-finger pinch: zoom; two-finger drag: pan when not in hold-drag mode; three-finger swipe: scroll (vertical and horizontal via RFB wheel buttons 6/7)
- **Smart sizing** — follows viewport/container size, min-clamped to native VNC resolution

## Architecture

```
Browser (Vite + React + @novnc/novnc RFB client)
    ↓ WebSocket (/vnc/ws, binary)
Express + ws (dumb WebSocket-to-TCP byte pipe, port 18890)
    ↓ Raw TCP (RFB)
TigerVNC (port 5901)
```

All protocol logic (decoding, resize, input, VNC auth) runs in the browser; the server only authenticates the WebSocket upgrade and pipes bytes. No guacd, no RDP.

## Development

```bash
cp .env.example .env   # edit connection settings as needed
bun install
bun run dev            # start the dev server + Vite
```

Open http://localhost:5173 — Vite proxies `/vnc/ws` and `/api` to the Express server on `GUAC_SERVER_PORT` (default `18890`).

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
| `VNC_HOST` | `127.0.0.1` | VNC server hostname |
| `VNC_PORT` | `5901` | VNC server port |
| `VNC_PASSWORD` | | VNC server password (sent to the authenticated browser, which performs VNC auth) |
| `GUAC_SERVER_PORT` | `18890` | Dev server listen port (also used by Vite proxy target) |
| `PORT` | `18890` | Production server listen port override |
| `HOST` | `127.0.0.1` | Server bind address |

`SITE_PASSWD` is required — the server will refuse to start without it. Generate a credential and add it to your `.env`:

```bash
bun server/gen-htpasswd.ts admin
# outputs: SITE_PASSWD=YWRtaW46JDJiJDEwJC4uLg==
```

The output is a ready-to-paste `.env` line (base64-encoded `username:bcrypt_hash`, no escaping needed).

## HiDPI (Mac desktop)

On non-touch devices the client requests a remote desktop of exactly `viewport CSS size × devicePixelRatio` via the RFB SetDesktopSize extension, then scales the canvas down by `1/devicePixelRatio` so one framebuffer pixel maps to one device pixel — pixel-crisp on Retina. (Stock noVNC sizes in CSS pixels; a small `RFB` subclass overrides its screen-size calculation, pinned to noVNC 1.7.0.)

Requirements on the VNC server side:

- **TigerVNC (Xvnc)** with `AcceptSetDesktopSize` enabled (the default) so client resize requests are honored.
- The desktop environment must scale its UI 2× or everything is crisp but tiny. The session scale is global, so switch it when moving between HiDPI and 1× clients.

Xfce 2×/1× toggle (run inside the VNC session, or with `DISPLAY=:1` from a shell):

```bash
# 2x (Retina)
xfconf-query -c xsettings -p /Xft/DPI -s 192
xfconf-query -c xsettings -p /Gtk/CursorThemeSize -s 48 --create -t int

# back to 1x (iPad/phone or non-HiDPI)
xfconf-query -c xsettings -p /Xft/DPI -s 96
xfconf-query -c xsettings -p /Gtk/CursorThemeSize -s 24 --create -t int
```

`/Xft/DPI` scales fonts (and most UI with them) live, no logout needed. For full widget scaling there is also `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s 2` (Appearance → Window Scaling), but note it multiplies with the DPI setting and some apps need a restart — start with DPI alone.

Touch devices (iPad/phone) keep 1× sizing and rely on pinch-zoom instead, same as before.

## Browser requirements

Requires the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (`crypto.subtle`) and a secure context (HTTPS or localhost) — noVNC also requires a secure context. The app will refuse to load on unsupported browsers.
