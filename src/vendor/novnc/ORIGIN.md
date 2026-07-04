# Vendored noVNC

- Upstream: https://github.com/novnc/noVNC
- Source: npm package `@novnc/novnc@1.7.0` (copied byte-identical, then locally
  modified as recorded below)
- License: MPL-2.0 (see `LICENSE.txt`; per-file headers must be preserved).
  The bundled pako (zlib) sources under `vendor/pako/` carry their own license
  (`vendor/pako/LICENSE`).

## Omitted upstream files

- `vendor/pako/lib/zlib/constants.js`, `vendor/pako/lib/zlib/gzheader.js` —
  not imported by anything in `core/`.

## Local modifications

Pruned subsystems this app can never exercise (the server proxy performs the
real VNC auth and offers the browser only security type None; the app has its
own input overlay and keeps the cursor rendered server-side):

- Deleted files: `core/ra2.js`, the entire `core/crypto/` directory,
  `core/input/gesturehandler.js`, `core/util/cursor.js`.
  (`server/vncAuth.test.ts` gets its DES reference implementation from the
  upstream `@novnc/novnc` devDependency instead.)
- `core/rfb.js`:
  - Client-side auth removed: only security type None is supported. Deleted
    all `_negotiate*Auth` methods (Xvp/VeNCrypt/Plain/StdVNC/ARD/TightUnix/
    TightTunnels/Tight/RA2ne/MSLogonII), `_handleRSAAES*`, `sendCredentials`,
    `approveServer`, `_resumeAuthentication`, `genDES`, credentials plumbing
    and all `credentialsrequired` event dispatches; collapsed
    `_isSupportedSecurityType`/`_negotiateAuthentication` to None; removed
    the TightVNC extended ServerInit branch.
  - Touch gestures removed: `_gestures`/GestureHandler wiring,
    `_handleGesture`, `_handleTapEvent`, `_fakeMouseMove`, gesture state and
    thresholds.
  - Local cursor rendering removed: Cursor wiring, `_handleCursor`,
    `_handleVMwareCursor` and their rect-dispatch arms, `_updateCursor`,
    `_shouldShowDotCursor`, `_refreshCursor`, `showDotCursor`, `RFB.cursors`;
    `_sendEncodings` no longer advertises the cursor pseudo-encodings (the
    server keeps compositing the cursor into the framebuffer).

Further dead-for-this-app API removed from `core/rfb.js`:

- XVP power extension: `machineShutdown/Reboot/Reset`, `_xvpOp`,
  `_handleXvpMsg`, the Xvp pseudo-encoding advertisement, `capabilities` /
  `_setCapability` and the `capabilities` event.
- Viewport clipping/dragging (the app resizes the remote instead):
  `clipViewport`, `dragViewport`, `clippingViewport` + its event,
  `_updateClip`, `_fixScrollbars`, the mouse drag-to-pan branches, and the
  legacy `touchButton` accessor.
- Unused public helpers: `sendCtrlAltDel`, `getImageData`, `toDataURL`,
  `toBlob`, the `background` accessor.
- Connection plumbing the app never uses: the constructor now takes only a
  WebSocket channel (URL/`sock.open` path removed) and no options object
  (`shared` always 1, `repeaterID`/UltraVNC-repeater handshake and
  `wsProtocols` removed).
- Decoders reduced to Tight, CopyRect and Raw (deleted
  `core/decoders/{h264,hextile,rre,zlib,tightpng,zrle,jpeg}.js` and their
  advertisements). A server may only send encodings the client advertises
  (plus Raw, which is always allowed); TigerVNC picks Tight.

App-specific behavior folded into `core/rfb.js` (formerly the `HiDpiRFB`
subclass in the app):

- Public `computeTargetSize` callback property: when set, `_screenSize()`
  returns its device-pixel result instead of the container CSS size, making
  exact HiDPI framebuffer sizing possible.
- App-controlled display scale: `setBaseScale(scale)` + `_updateScale()`
  reapplying it; the `scaleViewport` property and its autoscale path were
  removed.
- `_handleResize()` debounces `_requestRemoteResize()` by 250 ms
  (`RESIZE_REQUEST_DEBOUNCE_MS`) so window drags don't resize the remote
  desktop ~10×/s; the timer is cleared in `_disconnect()`.
- `_resize()` dispatches a `fbresize` CustomEvent (`{width, height}`).
- New public helpers: `requestResize()`, `sendPointer(x, y, buttonMask)`
  (clamped to the framebuffer; coordinates are unsigned 16-bit on the wire),
  and getters `connected`, `fbSize`, `canvasElement`, `screenElement`.

The fork's public API is declared in `src/novnc.d.ts`.
