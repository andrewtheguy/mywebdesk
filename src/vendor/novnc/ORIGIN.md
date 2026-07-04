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

- Deleted files: `core/ra2.js`, `core/crypto/{aes,bigint,crypto,dh,md5,rsa}.js`,
  `core/input/gesturehandler.js`, `core/util/cursor.js`.
  (`core/crypto/des.js` is kept, unbundled, as the reference implementation
  for `server/vncAuth.test.ts`.)
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
