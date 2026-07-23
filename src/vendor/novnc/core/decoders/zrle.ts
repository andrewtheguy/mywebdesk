/*
 * First-party ZRLE decoder for the RemoteX noVNC fork, implemented from the
 * RFB specification (RFC 6143 §7.7.6); not derived from upstream noVNC's
 * zrle.js. macOS Screen Sharing does not support Tight and would otherwise
 * fall back to completely uncompressed Raw updates.
 *
 * Relies on the client's fixed pixel format (32bpp, depth 24, little-endian,
 * shifts 0/8/16), which makes a ZRLE CPIXEL the 3 bytes [r, g, b].
 */

import Inflator from "../inflator";

const TILE_SIZE = 64;

interface ZrleSock {
  rQwait(msg: string, num: number, goback?: number): boolean;
  rQshift32(): number;
  rQshiftBytes(len: number, copy?: boolean): Uint8Array;
}

interface ZrleDisplay {
  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number[] | Uint8Array,
  ): void;
  blitImage(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    offset: number,
  ): void;
}

export default class ZRLEDecoder {
  // One zlib stream spans all ZRLE rects of a connection; each rect is a
  // length-prefixed continuation of it.
  private _inflator = new Inflator();
  private _tileBuffer = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  decodeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: ZrleSock,
    display: ZrleDisplay,
    _depth: number,
  ): boolean {
    if (sock.rQwait("ZRLE", 4)) {
      return false;
    }
    const length = sock.rQshift32();
    if (sock.rQwait("ZRLE", length, 4)) {
      return false;
    }

    this._inflator.setInput(sock.rQshiftBytes(length, false));
    for (let ty = y; ty < y + height; ty += TILE_SIZE) {
      const tileHeight = Math.min(TILE_SIZE, y + height - ty);
      for (let tx = x; tx < x + width; tx += TILE_SIZE) {
        const tileWidth = Math.min(TILE_SIZE, x + width - tx);
        this._decodeTile(tx, ty, tileWidth, tileHeight, display);
      }
    }
    this._inflator.setInput(null);

    return true;
  }

  // Returns a view into the inflator's reused output buffer: consume (or
  // copy) before the next read.
  private _read(count: number): Uint8Array {
    return this._inflator.inflate(count);
  }

  // RLE run length: 1 plus the sum of length bytes, where 255 means the
  // length continues in the next byte.
  private _readRunLength(): number {
    let length = 1;
    let byte: number;
    do {
      byte = this._read(1)[0];
      length += byte;
    } while (byte === 255);
    return length;
  }

  private _decodeTile(
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    const subencoding = this._read(1)[0];

    if (subencoding === 0) {
      this._tileRaw(tx, ty, tileWidth, tileHeight, display);
    } else if (subencoding === 1) {
      const c = this._read(3);
      display.fillRect(tx, ty, tileWidth, tileHeight, [c[0], c[1], c[2]]);
    } else if (subencoding <= 16) {
      this._tilePackedPalette(
        subencoding,
        tx,
        ty,
        tileWidth,
        tileHeight,
        display,
      );
    } else if (subencoding === 128) {
      this._tilePlainRle(tx, ty, tileWidth, tileHeight, display);
    } else if (subencoding >= 130) {
      this._tilePaletteRle(
        subencoding - 128,
        tx,
        ty,
        tileWidth,
        tileHeight,
        display,
      );
    } else {
      throw new Error(`ZRLE: invalid subencoding ${subencoding}`);
    }
  }

  private _blitTile(
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    display.blitImage(tx, ty, tileWidth, tileHeight, this._tileBuffer, 0);
  }

  private _tileRaw(
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    const total = tileWidth * tileHeight;
    const pixels = this._read(total * 3);
    const out = this._tileBuffer;
    for (let i = 0; i < total; i++) {
      out[i * 4] = pixels[i * 3];
      out[i * 4 + 1] = pixels[i * 3 + 1];
      out[i * 4 + 2] = pixels[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    this._blitTile(tx, ty, tileWidth, tileHeight, display);
  }

  private _readPalette(size: number): Uint8Array {
    // Copied out of the inflator buffer: it outlives the following reads.
    return this._read(size * 3).slice();
  }

  private _tilePackedPalette(
    paletteSize: number,
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    const palette = this._readPalette(paletteSize);
    const bits = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4;
    const bytesPerRow = Math.ceil((tileWidth * bits) / 8);
    const packed = this._read(bytesPerRow * tileHeight);
    const mask = (1 << bits) - 1;
    const out = this._tileBuffer;

    for (let py = 0; py < tileHeight; py++) {
      for (let px = 0; px < tileWidth; px++) {
        const bitOffset = py * bytesPerRow * 8 + px * bits;
        const index =
          (packed[bitOffset >> 3] >> (8 - bits - (bitOffset & 7))) & mask;
        const i = (py * tileWidth + px) * 4;
        out[i] = palette[index * 3];
        out[i + 1] = palette[index * 3 + 1];
        out[i + 2] = palette[index * 3 + 2];
        out[i + 3] = 255;
      }
    }
    this._blitTile(tx, ty, tileWidth, tileHeight, display);
  }

  private _fillTileRun(
    start: number,
    length: number,
    total: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (start + length > total) {
      throw new Error("ZRLE: run overflows tile");
    }
    const out = this._tileBuffer;
    for (let i = start; i < start + length; i++) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
  }

  private _tilePlainRle(
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    const total = tileWidth * tileHeight;
    let i = 0;
    while (i < total) {
      const c = this._read(3);
      const [r, g, b] = [c[0], c[1], c[2]];
      const length = this._readRunLength();
      this._fillTileRun(i, length, total, r, g, b);
      i += length;
    }
    this._blitTile(tx, ty, tileWidth, tileHeight, display);
  }

  private _tilePaletteRle(
    paletteSize: number,
    tx: number,
    ty: number,
    tileWidth: number,
    tileHeight: number,
    display: ZrleDisplay,
  ): void {
    const palette = this._readPalette(paletteSize);
    const total = tileWidth * tileHeight;
    let i = 0;
    while (i < total) {
      const first = this._read(1)[0];
      const index = (first & 0x7f) * 3;
      const length = first & 0x80 ? this._readRunLength() : 1;
      this._fillTileRun(
        i,
        length,
        total,
        palette[index],
        palette[index + 1],
        palette[index + 2],
      );
      i += length;
    }
    this._blitTile(tx, ty, tileWidth, tileHeight, display);
  }
}
