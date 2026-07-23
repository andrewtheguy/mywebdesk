# remotex

> [!WARNING]
> This project is meant for a single user.
> No backward compatibility while it is still v0.0.x.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

Minimal, mobile-friendly VNC viewer with a typed remote-session architecture.
Its RFB adapter uses a heavily pruned TypeScript fork of noVNC 1.7.0 while the
React layer remains independent of noVNC APIs.

## Features

- **1:1 device-pixel rendering** — the remote desktop is resized to exactly `viewport × devicePixelRatio` and rendered 1:1 in device pixels (see below)
- **Visible menu toggle** — FAB button always visible (no Ctrl+Alt+Shift or swipe needed)
- **Consistent touch controls** — one-finger tap: left-click at cursor; hard-press: hold left-click; second-finger directional drag: move cursor while hold-drag is active; two-finger tap: right-click; two-finger pinch: zoom; two-finger drag: pan when not in hold-drag mode; three-finger swipe: scroll (vertical and horizontal via RFB wheel buttons 6/7)
- **Smart sizing** — follows viewport/container size, min-clamped to native VNC resolution

## Architecture

```
Browser (React remote-session UI + RFB adapter)
    ↓ WebSocket (/vnc/ws, binary)
Express + ws (dumb WebSocket-to-TCP byte pipe, port 18890)
    ↓ Raw TCP (RFB)
TigerVNC (port 5901)
```

Rendering, resize, and input all run in the browser; the server authenticates the WebSocket upgrade, performs the RFB security handshake with the VNC server (so `VNC_PASSWORD` never leaves the server), and then pipes bytes. No extra protocol daemon, no RDP.

See [Architecture](docs/architecture.md) for the TypeScript boundaries and the
extension path for another remote protocol such as SSH.

### VNC authentication

The proxy handles the RFB security phase itself: it answers TigerVNC's VncAuth DES challenge with `VNC_PASSWORD` server-side, presents security type *None* to the browser, then splices the two byte streams. The VNC password is therefore never sent to the client and never appears in any client-visible response.

## Development

```bash
cp .env.example .env   # edit connection settings as needed
bun install
bun run dev            # start the dev server + Vite
bun run check          # Biome + strict TypeScript
bun test
```

Open http://localhost:5173 — Vite proxies `/vnc/ws` and `/api` to the Express server on `REMOTEX_SERVER_PORT` (default `18890`).

## Install (prebuilt binary)

Single self-contained executable (Bun runtime + frontend embedded); no Bun or
`node_modules` needed at runtime. Downloads from
[Releases](https://github.com/andrewtheguy/remotex/releases):

```bash
curl -fsSL https://andrewtheguy.github.io/remotex/install.sh | bash
```

Installs to `~/.local/bin/remotex`. Supported platforms: Linux (amd64, arm64),
macOS (arm64). The binary does **not** read a `.env` — pass config as real env
vars:

```bash
SITE_PASSWD=... VNC_HOST=127.0.0.1 VNC_PORT=5901 VNC_PASSWORD=... \
  PORT=18890 HOST=127.0.0.1 remotex
```

## Build the binary yourself

```bash
bun install
bun run compile        # -> bin/remotex (current platform)
```

## Production (from source)

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
| `VNC_PASSWORD` | | VNC server password (used server-side; never sent to the client) |
| `REMOTEX_SERVER_PORT` | `18890` | Dev server listen port (also used by Vite proxy target) |
| `PORT` | `18890` | Production server listen port override |
| `HOST` | `127.0.0.1` | Server bind address |

`SITE_PASSWD` is required — the server will refuse to start without it. Generate a credential and add it to your `.env`:

```bash
bun server/gen-htpasswd.ts admin
# outputs: SITE_PASSWD=YWRtaW46JDJiJDEwJC4uLg==
```

The output is a ready-to-paste `.env` line (base64-encoded `username:bcrypt_hash`, no escaping needed).

## HiDPI (Mac desktop) — partial workaround

This is a workaround that helps, not full HiDPI support: the client can render the framebuffer crisply, but true HiDPI depends on the remote desktop environment scaling its own UI, which is a global session setting with the limitations noted below.

On non-touch devices the client requests a remote desktop of exactly `viewport CSS size × devicePixelRatio` via the RFB SetDesktopSize extension, then scales the canvas down by `1/devicePixelRatio` so one framebuffer pixel maps to one device pixel — pixel-crisp on Retina. (Stock noVNC sizes in CSS pixels; the vendored fork's `RFB` takes an injected device-pixel target via its `computeTargetSize` property.)

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

Requires the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (`crypto.subtle`) and a secure context (HTTPS or localhost). The app will refuse to load on unsupported browsers.

## Install as an app (PWA)

The app ships a web manifest and a network-only service worker, so Chrome/Edge
(desktop and Android) and iOS Safari can install it as a standalone app with its
own window and launcher icon — no tabs or toolbar. In the browser, use the
**Install** button in the address bar (desktop) or **Add to Home Screen**
(mobile).

The service worker **caches nothing** — it exists only to satisfy the
installability requirement. Combined with `Cache-Control: no-cache` on
`index.html`, the service worker, the manifest, and the icons, the installed app
always loads fresh content and never serves stale assets. Only the content-hashed
`/assets/*` bundles are cached (`immutable`), which is always safe.

## Standalone window (Chrome app mode)

Alternatively, without installing, run the viewer in its own window with no tabs
or toolbar by launching Chrome with `--app=<url>`. Add a dedicated
`--user-data-dir` so it always opens a separate instance (and keeps its session
isolated from your normal browsing):

```bash
# macOS — invoke the binary directly; `open -a ... --args` is ignored when
# Chrome is already running and just opens a tab in the existing window.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --app=https://your-host/ \
  --user-data-dir="$HOME/.remotex-chrome"

# Linux
google-chrome --app=https://your-host/ --user-data-dir="$HOME/.remotex-chrome"

# Windows
chrome.exe --app=https://your-host/ --user-data-dir="%USERPROFILE%\.remotex-chrome"
```

Optional: `--window-size=1280,800`, `--start-fullscreen`, or `--kiosk` (fullscreen,
locked; exit with Alt+F4 / Cmd+Q).
