# remotex

> [!WARNING]
> This project is meant for a single user.
> No backward compatibility while it is still v0.0.x.
> This project is still experimental: behavior may be unstable, features may change or be removed without notice, and updates may introduce regressions.

Minimal, mobile-friendly VNC viewer with a typed remote-session architecture.
Its RFB adapter.

## Features

- **1:1 device-pixel rendering** — the remote desktop is resized to exactly `viewport × devicePixelRatio` and rendered 1:1 in device pixels (see below)
- **WebGL2-only framebuffer** — dirty rectangles upload directly into a GPU texture; fills, CopyRect operations, scaling, and presentation stay on the GPU
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

Rendering, resize, and input all run in the browser; the server authenticates the WebSocket upgrade, performs the RFB security handshake with the VNC server (so the target's VNC password never leaves the server), and then pipes bytes. No extra protocol daemon, no RDP.

See [Architecture](docs/architecture.md) for the TypeScript boundaries and the
extension path for another remote protocol such as SSH.

### VNC authentication

The proxy handles the RFB security phase itself: it answers TigerVNC's VncAuth DES challenge with the selected target's `password` server-side, presents security type *None* to the browser, then splices the two byte streams. The VNC password is therefore never sent to the client and never appears in any client-visible response.

## Development

```bash
cp remotex.example.toml remotex.toml   # edit connection settings as needed
bun install
bun run dev            # start the dev server + Vite
bun run check          # Biome + strict TypeScript
bun test
```

Open http://localhost:5173 — Vite proxies `/vnc/ws` and `/api` to the Express server on `[server].port` from `remotex.toml` (default `18890`).

## Install (prebuilt binary)

Single self-contained executable (Bun runtime + frontend embedded); no Bun or
`node_modules` needed at runtime. Downloads from
[Releases](https://github.com/andrewtheguy/remotex/releases):

```bash
curl -fsSL https://andrewtheguy.github.io/remotex/install.sh | bash
```

Installs to `~/.local/bin/remotex`. Supported platforms: Linux (amd64, arm64),
macOS (arm64). Config comes from a TOML file (see below):

```bash
remotex                          # uses ./remotex.toml or ~/.config/remotex/config.toml
remotex --config /path/to.toml   # explicit config file
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

Serves the built frontend from `dist/` on the configured port (default 18890).

## Configuration

All config lives in a TOML file. The server looks for `./remotex.toml`, then
`~/.config/remotex/config.toml`; `--config <path>` points at a specific file.

```toml
[server]
host = "127.0.0.1"      # listen address (optional)
port = 18890            # listen port (optional)
site_passwd = "..."     # base64 username:bcrypt_hash for the web login (required)

# One or more VNC target profiles; the profile is chosen in the UI after login.
[[targets]]
name = "office"
host = "10.0.0.1"
port = 5900
password = "..."        # used server-side only; never sent to the client

[[targets]]
name = "home"
host = "10.0.0.2"
port = 5901
```

See `remotex.example.toml` for a commented template. Multiple targets are just
profiles to pick from — there is still only a single active session at a time.

CLI options:

```
-c, --config <path>  TOML config file
    --host <addr>    Listen address (overrides [server].host)
-p, --port <port>    Listen port (overrides [server].port)
-v, --version        Print version and exit
-h, --help           Print this help and exit
```

`site_passwd` is required — the server will refuse to start without it. Generate a credential and paste it into your config:

```bash
bun server/gen-htpasswd.ts admin
# outputs: YWRtaW46JDJiJDEwJC4uLg==
```

The output is the ready-to-paste `site_passwd` value (base64-encoded `username:bcrypt_hash`, no escaping needed).

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

Requires all of the following:

- Hardware-accelerated **WebGL2** without a major performance caveat. There is
  intentionally no Canvas 2D, WebGL1, or software-rendering fallback.
- The [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
  (`crypto.subtle`).
- A secure context (HTTPS or localhost).

The app refuses to start when these requirements are unavailable.

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
