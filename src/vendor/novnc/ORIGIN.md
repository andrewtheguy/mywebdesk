# Vendored noVNC

- Upstream: https://github.com/novnc/noVNC
- Source: npm package `@novnc/novnc@1.7.0` (copied byte-identical, then locally
  modified as recorded below)
- License: MPL-2.0 (see `LICENSE.txt`; per-file headers must be preserved).
  zlib support now comes from the external npm package `pako` (MIT).

## Omitted upstream files

- The entire bundled `vendor/pako/` subtree was removed; `core/inflator.ts`
  and `core/deflator.ts` import `pako`'s public low-level zlib exports instead.

## Local modifications

Pruned subsystems this app can never exercise (the server proxy performs the
real VNC auth and offers the browser only security type None; the app has its
own input overlay and keeps the cursor rendered server-side):

- Deleted files: `core/ra2.js`, the entire `core/crypto/` directory,
  `core/input/gesturehandler.js`, `core/util/cursor.js`,
  `core/util/element.js`.
  (`server/vncAuth.test.ts` uses fixed VNC authentication regression vectors,
  so the upstream package is not retained as a dependency.)
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

RFB's built-in input layer removed. The app's overlay sits above the canvas
and synthesizes all input through the public `sendKey()`/`sendPointer()`/
`clipboardPasteFrom()` methods, and the app creates its own
`core/input/keyboard.js` `Keyboard` on its container, so none of RFB's own
canvas-attached handlers could ever fire:

- `core/rfb.js`: removed the canvas mouse/wheel/focus listeners and their
  handlers (`_handleMouse`, `_handleMouseButton/Move`, `_sendMouse`,
  `_handleWheel`, `_convertButtonMask`, `_focusCanvas`, the move-throttle
  timer and wheel-accumulation state), the internal `Keyboard` instance with
  its `_handleKeyEvent` caps/num-lock resync (the app's key path already
  bypassed it), the `viewOnly`/`focusOnClick` properties and `focus()`/
  `blur()` (the canvas is never focused), the ExtendedMouseButtons and
  QEMU LED pseudo-encoding advertisements + handling (`_handleLedEvent`,
  `_extendedPointerEventSupported`) and the `extendedPointerEvent` message —
  the app never sends button bits above 0x7f.
- `core/display.js`: removed `absX`/`absY` (only the deleted mouse path
  translated coordinates).
- `core/util/events.js` reduced to `stopEvent` (the `setCapture`/
  `releaseCapture` emulation served only the deleted mouse path);
  `core/util/element.js` (`clientToElement`) deleted.

Dead-code sweep across the supporting modules (nothing here was referenced
by any remaining fork or app code):

- `core/util/browser.js` reduced to `isMac`/`isWindows`/`isIOS` (the only
  detections the keyboard code uses). Deleted the WebCodecs H.264 probe left
  over from the removed h264 decoder — including its module-top-level
  `await` — plus `isTouchDevice`, `dragThreshold`, `supportsCursorURIs`,
  `hasScrollbarGutter` and the remaining browser/engine sniffers.
- `core/base64.js`: `decode`/`toBinaryTable`/`base64Pad` removed (their only
  caller was the deleted H.264 probe); only `encode` remains, for the Tight
  JPEG data-URI path in `core/display.js`.
- `core/encodings.js`: dropped the constants for deleted decoders and
  removed pseudo-encodings, the unused `…Level9` sentinels, and the
  `encodingName()` debug helper.
- `core/display.js`: removed the permanently-disabled viewport machinery
  (`clipViewport`, `viewportChangePos/Size`, `_viewportLoc`; `resize()` now
  sizes the visible canvas to the framebuffer directly), the H.264
  `videoFrame()`/`'frame'` render-queue arm, and unused `autoscale()`,
  `getImageData()`, `toDataURL()`, `toBlob()`, `width`/`height` getters.
- `core/websock.js`: removed `open()` (the fork only ever `attach()`es an
  existing WebSocket) and `rQlen()`.
- `core/websock.ts`: removed RTCDataChannel compatibility and runtime
  duck-typing. RemoteX constructs a browser `WebSocket`, and the concrete type
  is now enforced end to end.
- `core/util/events.js`: removed the touch-era `getPointerEvent()`.
- `core/util/logging.js`: fixed at the 'warn' level (`initLogging`/
  `getLogging` were unreachable).
- `core/rfb.js`: removed the `qualityLevel`/`compressionLevel` accessors;
  the former defaults are advertised as fixed `QUALITY_LEVEL`/
  `COMPRESSION_LEVEL` constants.

Modernized onto built-in browser APIs:

- `core/util/eventtarget.js` deleted; `RFB` extends the native
  `EventTarget` (identical add/remove/dispatch semantics for the
  function listeners the app uses).
- `core/base64.js` deleted; the Tight JPEG data-URI path in
  `core/display.js` uses native `btoa` (chunked `String.fromCharCode` to
  stay under the argument limit).

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

The fork is imported only by `src/remoteDesktop/rfb/RfbRemoteDesktopSession.ts`.
That adapter exposes the app-owned `RemoteDesktopSession` contract, so noVNC
types or event names do not leak into the React layer.

TypeScript migration:

- Renamed the remaining vendored JavaScript modules under this fork from
  `.js` to `.ts`, updated internal import specifiers to extensionless module
  paths, and initially added `// @ts-nocheck` pragmas after existing file
  headers so the fork remained behaviorally unchanged while being consumed as
  TypeScript.
- Removed `// @ts-nocheck` from the constant/data modules and added focused
  table types: `core/encodings.ts`, `core/input/{domkeytable,fixedkeys,keysym,
  keysymdef,vkeys,xtscancodes}.ts`.
- Removed `// @ts-nocheck` from the next small helper modules and added narrow
  signatures/local interfaces: `core/util/browser.ts`,
  `core/util/events.ts`, `core/util/int.ts`, `core/util/logging.ts`,
  `core/util/strings.ts`, `core/decoders/copyrect.ts`,
  `core/decoders/raw.ts`, `core/input/util.ts`, `core/inflator.ts`, and
  `core/deflator.ts`.
- Removed `// @ts-nocheck` from `core/input/keyboard.ts`, typing its DOM
  event listener plumbing, legacy key-identification fallback, AltGr timeout
  state and nullable keysym path.
- Removed the last `// @ts-nocheck` pragmas from `core/websock.ts`,
  `core/display.ts`, `core/decoders/tight.ts` and `core/rfb.ts`; the whole
  fork now type-checks under `strict`. Notable decisions:
  - `websock.ts`: a named `WebsockEventHandlers` map; receive/send queues are
    definite-assigned (`_rQ!`/`_sQ!`, allocated in `_allocateBuffers`).
  - `display.ts`: the render queue is a discriminated `RenderAction` union;
    the vendor-prefixed `*ImageSmoothingEnabled` toggles use a local cast
    (not in lib.dom); the pending-image `load` handler keeps its
    `this`-bound-to-`<img>` semantics via an explicit `this: HTMLImageElement`
    on `_resumeRenderQ` plus a module-local `HTMLImageElement._remoteDisplay`
    augmentation.
  - `tight.ts`: local structural `TightSock`/`TightDisplay` interfaces (as in
    `raw.ts`/`copyrect.ts`); `_zlibs` keeps the concrete `Inflator` type since
    it is instantiated. `decodeRect` captures `_ctl` into a local so the
    dispatch reads a plain `number` across the stream-reset method calls.
  - `rfb.ts`: a shared `Decoder` interface backs `_decoders`; connection/init
    states are string-literal unions; the post-class `RFB.messages = {…}` bag
    became a `static messages` member; nullable-during-lifecycle deps stay
    `| null` while constructor-owned singletons (`_sock`/`_display`/
    `_resizeObserver`) are definite-assigned, and the debounce/timeout handles
    switched from `null` to `undefined` so `clearTimeout` accepts them.
- Removed the hand-written `src/novnc.d.ts` ambient declaration and Vite-only
  `@novnc-core` alias. TypeScript now checks the concrete source modules.
- The fork is included in the repository-wide Biome checks and formatted with
  the same rules as first-party code while retaining all MPL-2.0 headers.
