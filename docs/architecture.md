# Architecture

RemoteX is a single-user remote-access application. The UI owns session
lifecycle and interaction policy; protocol implementations own wire details.
The current implementation supports RFB, but the React layer does not import
noVNC types or event names.

```text
App.tsx
  └─ useRemoteDesktop.ts
       └─ RemoteDesktopSession (app-owned TypeScript contract)
            └─ RfbRemoteDesktopSession (RFB adapter)
                 └─ vendored RFB engine
                      └─ WebGl2FramebufferRenderer (app-owned GPU renderer)

Browser WebSocket
  └─ /vnc/ws
       └─ vncProxy.ts
            ├─ server-side RFB authentication
            └─ TCP byte pipe to the configured VNC server
```

## Boundaries

`RemoteDesktopSession` is the stable client boundary. It describes rendering
elements, framebuffer sizing, keyboard/pointer/clipboard input, lifecycle
events, and cleanup without exposing RFB names. `useRemoteDesktop` depends on a
session factory supplied by `App`, so choosing a protocol is composition rather
than a hidden dependency inside the hook.

`RfbRemoteDesktopSession` is the translation layer. It is the only first-party
module allowed to import the vendored engine. It converts noVNC event names and
custom methods into the app-owned contract and owns the noVNC keyboard helper.

`WebGl2FramebufferRenderer` is first-party rendering infrastructure rather than
part of the protocol fork. It owns a persistent RGBA8 framebuffer texture. Raw
and Tight pixel rectangles use `texSubImage2D`, solid fills and CopyRect use GPU
framebuffers, and a minimal shader presents the completed RFB update. CopyRect
uses a reusable scratch framebuffer so overlapping source and destination
regions remain correct without allocating on every operation.

WebGL2 with hardware acceleration is mandatory. Startup performs the same
high-performance context check used by the renderer, and there is no Canvas 2D
or WebGL1 fallback. A lost context fails the active RFB connection instead of
silently switching renderers.

The vendored RFB engine remains isolated because it is MPL-2.0 code with a
traceable upstream origin. Unlike a conventional untyped vendor drop, its
concrete TypeScript sources are included in both `tsc` and Biome checks. Local
changes are recorded in `src/vendor/novnc/ORIGIN.md`.

The server remains a deliberately protocol-light WebSocket-to-TCP pipe after
the authentication handshake. Browser session ownership is kept in
`server/session.ts`; transport code stays in `server/vncProxy.ts`.

## Adding another remote protocol

Do not add protocol conditionals to `useRemoteDesktop`. Add an adapter that
implements `RemoteDesktopSession`, then select its factory at the composition
root. If a protocol has a different interaction model, such as an SSH terminal,
give it a protocol-specific hook and view while reusing app-level authentication
and session ownership.

An SSH implementation modeled after `../mywebterm` should therefore introduce:

1. An SSH/PTY server transport and an explicit typed WebSocket message codec.
2. A terminal session adapter and hook, separate from framebuffer gestures.
3. A protocol choice at the app composition layer.
4. Protocol-neutral authentication and single-user session ownership shared by
   both paths.

This keeps terminal concepts such as rows, columns, scrollback, and PTY resume
out of the framebuffer contract, while still making the application easy to
extend.

## Type and quality policy

- TypeScript checks concrete source modules; there are no ambient declarations
  for the RFB engine.
- The framebuffer renderer targets WebGL2 exclusively.
- `strict`, `verbatimModuleSyntax`, forced module detection, and modern
  ES/DOM libraries are enabled.
- Biome checks first-party and vendored TypeScript with one repository-wide
  configuration.
- Bun is the package manager, runtime, and test runner.
- Backward compatibility is intentionally not preserved during the `0.0.x`
  architecture phase.
