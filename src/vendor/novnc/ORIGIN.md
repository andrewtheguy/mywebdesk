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

(none yet)
