# guac-vnc

> [!WARNING]
> This program is meant for the original developer's personal use; no backward compatibility, user-friendliness, or multi-user security is required.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

Minimal, mobile-friendly remote desktop viewer (VNC or RDP, selected via `REMOTE_PROTOCOL`) using `guacamole-common-js` with a custom UI.

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
guacd (port 14822 in prod, 24822 in dev)
    ↓ VNC or RDP protocol (REMOTE_PROTOCOL)
TigerVNC (port 5901) or xrdp (port 3389)
```

## Development

```bash
cp .env.example .env   # edit connection settings as needed
bun install
bun run dev:guacd      # start guacd in a container (run separately, keeps running)
bun run dev            # start the dev server + Vite
```

The `dev:guacd` script runs guacd in a Podman container with `pasta` networking (`--map-host-loopback,169.254.0.1`), publishing port `24822` on localhost. Required `.env` settings for development:

```
VNC_HOST=169.254.0.1
GUACD_HOST=127.0.0.1
GUACD_PORT=24822
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
| `REMOTE_PROTOCOL` | `vnc` | Remote protocol: `vnc` or `rdp` |
| `VNC_PASSWORD` | | VNC server password |
| `GUAC_SERVER_PORT` | `18890` | Dev server listen port (also used by Vite proxy target) |
| `PORT` | `18890` | Production server listen port override |
| `HOST` | `127.0.0.1` | Server bind address |
| `GUACD_HOST` | `127.0.0.1` | guacd hostname |
| `GUACD_PORT` | `14822` | guacd port (use `24822` for dev) |
| `VNC_HOST` | `169.254.0.1` | VNC server hostname (`REMOTE_PROTOCOL=vnc`) |
| `VNC_PORT` | `5901` | VNC server port |
| `RDP_HOST` | `127.0.0.1` | RDP server hostname (`REMOTE_PROTOCOL=rdp`; use `169.254.0.1` with the podman guacd setup) |
| `RDP_PORT` | `3389` | RDP server port |
| `RDP_USERNAME` | | RDP login username (Unix account on the xrdp host) |
| `RDP_PASSWORD` | | RDP login password |
| `DEBUG_GUAC_PROXY` | `0` | Enable guac proxy debug logs when set to `1` |

`SITE_PASSWD` is required — the server will refuse to start without it. Generate a credential and add it to your `.env`:

```bash
bun server/gen-htpasswd.ts admin
# outputs: SITE_PASSWD=YWRtaW46JDJiJDEwJC4uLg==
```

The output is a ready-to-paste `.env` line (base64-encoded `username:bcrypt_hash`, no escaping needed).

## HiDPI (Mac desktop)

The browser client requests a DPR-scaled framebuffer on non-touch devices, but VNC has no DPI concept, so the remote desktop renders at 1x (tiny UI on Retina). For crisp HiDPI on a Mac, connect natively over RDP instead — the browser path stays available for phones/tablets:

- Host runs **xrdp + xorgxrdp** (bound to `127.0.0.1:3389`) alongside TigerVNC, same Xfce DE for both.
- `~/.xsession` (used only by xrdp sessions) picks the Xfce config profile by initial screen width: `>= 2000px` → `~/.config-hidpi` (2x `Gdk/WindowScalingFactor`, isolated `xfce4` config, everything else symlinked to `~/.config`), otherwise the normal 1x profile shared with the VNC session.
- On the Mac, use **Windows App** with *Optimize for Retina displays* enabled, connecting through an SSH tunnel: `ssh -L 13389:127.0.0.1:3389 <host>`, then connect to `localhost:13389`.

The RDP and VNC sessions are separate desktops (UI scale is per-session), both can be active at the same time. Setting `REMOTE_PROTOCOL=rdp` points the browser client at xrdp too (each path keeps its own session).

## Browser requirements

Requires the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (`crypto.subtle`). This is available in all modern browsers when served over HTTPS or localhost. The app will refuse to load on unsupported browsers.
