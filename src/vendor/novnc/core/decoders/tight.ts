/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * (c) 2012 Michael Tinglof, Joe Balaz, Les Piech (Mercuri.ca)
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

import Inflator from "../inflator";
import * as Log from "../util/logging";

// The subset of Websock the Tight decoder reads from.
interface TightSock {
  rQwait(msg: string, num: number): boolean;
  rQshift8(): number;
  rQpeek8(): number;
  rQskipBytes(bytes: number): void;
  rQshiftBytes(len: number, copy?: boolean): Uint8Array;
  rQshiftTo(target: Uint8Array, len: number): void;
}

// The subset of Display the Tight decoder draws to.
interface TightDisplay {
  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number[] | Uint8Array,
    fromQueue: boolean,
  ): void;
  imageRect(
    x: number,
    y: number,
    width: number,
    height: number,
    mime: string,
    arr: Uint8Array,
  ): void;
  blitImage(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    offset: number,
    fromQueue: boolean,
  ): void;
}

export default class TightDecoder {
  private _ctl: number | null;
  private _filter: number | null;
  private _numColors: number;
  private _palette: Uint8Array;
  private _len: number;
  private _zlibs: Inflator[];
  private _scratchBuffer?: Uint8Array;

  constructor() {
    this._ctl = null;
    this._filter = null;
    this._numColors = 0;
    this._palette = new Uint8Array(1024); // 256 * 4 (max palette size * max bytes-per-pixel)
    this._len = 0;

    this._zlibs = [];
    for (let i = 0; i < 4; i++) {
      this._zlibs[i] = new Inflator();
    }
  }

  decodeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    depth: number,
  ): boolean {
    if (this._ctl === null) {
      if (sock.rQwait("TIGHT compression-control", 1)) {
        return false;
      }

      const ctl = sock.rQshift8();

      // Reset streams if the server requests it
      for (let i = 0; i < 4; i++) {
        if ((ctl >> i) & 1) {
          this._zlibs[i].reset();
          Log.Info(`Reset zlib stream ${i}`);
        }
      }

      // Figure out filter
      this._ctl = ctl >> 4;
    }

    // _ctl is now known to be set (either just read, or carried from a
    // prior partial call); capture it so the dispatch reads a plain number.
    const ctl = this._ctl;

    let ret: boolean;

    if (ctl === 0x08) {
      ret = this._fillRect(x, y, width, height, sock, display, depth);
    } else if (ctl === 0x09) {
      ret = this._jpegRect(x, y, width, height, sock, display, depth);
    } else if (ctl === 0x0a) {
      ret = this._pngRect(x, y, width, height, sock, display, depth);
    } else if ((ctl & 0x08) === 0) {
      ret = this._basicRect(ctl, x, y, width, height, sock, display, depth);
    } else {
      throw new Error(`Illegal tight compression received (ctl: ${ctl})`);
    }

    if (ret) {
      this._ctl = null;
    }

    return ret;
  }

  _fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    _depth: number,
  ): boolean {
    if (sock.rQwait("TIGHT", 3)) {
      return false;
    }

    const pixel = sock.rQshiftBytes(3);
    display.fillRect(x, y, width, height, pixel, false);

    return true;
  }

  _jpegRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    _depth: number,
  ): boolean {
    const data = this._readData(sock);
    if (data === null) {
      return false;
    }

    display.imageRect(x, y, width, height, "image/jpeg", data);

    return true;
  }

  _pngRect(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _sock: TightSock,
    _display: TightDisplay,
    _depth: number,
  ): boolean {
    throw new Error("PNG received in standard Tight rect");
  }

  _basicRect(
    ctl: number,
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    depth: number,
  ): boolean {
    if (this._filter === null) {
      if (ctl & 0x4) {
        if (sock.rQwait("TIGHT", 1)) {
          return false;
        }

        this._filter = sock.rQshift8();
      } else {
        // Implicit CopyFilter
        this._filter = 0;
      }
    }

    const streamId = ctl & 0x3;

    let ret: boolean;

    switch (this._filter) {
      case 0: // CopyFilter
        ret = this._copyFilter(
          streamId,
          x,
          y,
          width,
          height,
          sock,
          display,
          depth,
        );
        break;
      case 1: // PaletteFilter
        ret = this._paletteFilter(
          streamId,
          x,
          y,
          width,
          height,
          sock,
          display,
          depth,
        );
        break;
      case 2: // GradientFilter
        ret = this._gradientFilter(
          streamId,
          x,
          y,
          width,
          height,
          sock,
          display,
          depth,
        );
        break;
      default:
        throw new Error(`Illegal tight filter received (ctl: ${this._filter})`);
    }

    if (ret) {
      this._filter = null;
    }

    return ret;
  }

  _copyFilter(
    streamId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    _depth: number,
  ): boolean {
    const uncompressedSize = width * height * 3;
    let data: Uint8Array | null;

    if (uncompressedSize === 0) {
      return true;
    }

    if (uncompressedSize < 12) {
      if (sock.rQwait("TIGHT", uncompressedSize)) {
        return false;
      }

      data = sock.rQshiftBytes(uncompressedSize);
    } else {
      data = this._readData(sock);
      if (data === null) {
        return false;
      }

      this._zlibs[streamId].setInput(data);
      data = this._zlibs[streamId].inflate(uncompressedSize);
      this._zlibs[streamId].setInput(null);
    }

    const rgbx = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
      rgbx[i] = data[j];
      rgbx[i + 1] = data[j + 1];
      rgbx[i + 2] = data[j + 2];
      rgbx[i + 3] = 255; // Alpha
    }

    display.blitImage(x, y, width, height, rgbx, 0, false);

    return true;
  }

  _paletteFilter(
    streamId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    _depth: number,
  ): boolean {
    if (this._numColors === 0) {
      if (sock.rQwait("TIGHT palette", 1)) {
        return false;
      }

      const numColors = sock.rQpeek8() + 1;
      const paletteSize = numColors * 3;

      if (sock.rQwait("TIGHT palette", 1 + paletteSize)) {
        return false;
      }

      this._numColors = numColors;
      sock.rQskipBytes(1);

      sock.rQshiftTo(this._palette, paletteSize);
    }

    const bpp = this._numColors <= 2 ? 1 : 8;
    const rowSize = Math.floor((width * bpp + 7) / 8);
    const uncompressedSize = rowSize * height;

    let data: Uint8Array | null;

    if (uncompressedSize === 0) {
      return true;
    }

    if (uncompressedSize < 12) {
      if (sock.rQwait("TIGHT", uncompressedSize)) {
        return false;
      }

      data = sock.rQshiftBytes(uncompressedSize);
    } else {
      data = this._readData(sock);
      if (data === null) {
        return false;
      }

      this._zlibs[streamId].setInput(data);
      data = this._zlibs[streamId].inflate(uncompressedSize);
      this._zlibs[streamId].setInput(null);
    }

    // Convert indexed (palette based) image data to RGB
    if (this._numColors === 2) {
      this._monoRect(x, y, width, height, data, this._palette, display);
    } else {
      this._paletteRect(x, y, width, height, data, this._palette, display);
    }

    this._numColors = 0;

    return true;
  }

  _monoRect(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    palette: Uint8Array,
    display: TightDisplay,
  ): void {
    // Convert indexed (palette based) image data to RGB
    // TODO: reduce number of calculations inside loop
    const dest = this._getScratchBuffer(width * height * 4);
    const w = Math.floor((width + 7) / 8);
    const w1 = Math.floor(width / 8);

    for (let y = 0; y < height; y++) {
      let dp: number;
      let sp: number;
      let x: number;
      for (x = 0; x < w1; x++) {
        for (let b = 7; b >= 0; b--) {
          dp = (y * width + x * 8 + 7 - b) * 4;
          sp = ((data[y * w + x] >> b) & 1) * 3;
          dest[dp] = palette[sp];
          dest[dp + 1] = palette[sp + 1];
          dest[dp + 2] = palette[sp + 2];
          dest[dp + 3] = 255;
        }
      }

      for (let b = 7; b >= 8 - (width % 8); b--) {
        dp = (y * width + x * 8 + 7 - b) * 4;
        sp = ((data[y * w + x] >> b) & 1) * 3;
        dest[dp] = palette[sp];
        dest[dp + 1] = palette[sp + 1];
        dest[dp + 2] = palette[sp + 2];
        dest[dp + 3] = 255;
      }
    }

    display.blitImage(x, y, width, height, dest, 0, false);
  }

  _paletteRect(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    palette: Uint8Array,
    display: TightDisplay,
  ): void {
    // Convert indexed (palette based) image data to RGB
    const dest = this._getScratchBuffer(width * height * 4);
    const total = width * height * 4;
    for (let i = 0, j = 0; i < total; i += 4, j++) {
      const sp = data[j] * 3;
      dest[i] = palette[sp];
      dest[i + 1] = palette[sp + 1];
      dest[i + 2] = palette[sp + 2];
      dest[i + 3] = 255;
    }

    display.blitImage(x, y, width, height, dest, 0, false);
  }

  _gradientFilter(
    streamId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    sock: TightSock,
    display: TightDisplay,
    _depth: number,
  ): boolean {
    // assume the TPIXEL is 3 bytes long
    const uncompressedSize = width * height * 3;
    let data: Uint8Array | null;

    if (uncompressedSize === 0) {
      return true;
    }

    if (uncompressedSize < 12) {
      if (sock.rQwait("TIGHT", uncompressedSize)) {
        return false;
      }

      data = sock.rQshiftBytes(uncompressedSize);
    } else {
      data = this._readData(sock);
      if (data === null) {
        return false;
      }

      this._zlibs[streamId].setInput(data);
      data = this._zlibs[streamId].inflate(uncompressedSize);
      this._zlibs[streamId].setInput(null);
    }

    const rgbx = new Uint8Array(4 * width * height);

    let rgbxIndex = 0,
      dataIndex = 0;
    const left = new Uint8Array(3);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const prediction = left[c];
        const value = data[dataIndex++] + prediction;
        rgbx[rgbxIndex++] = value;
        left[c] = value;
      }
      rgbx[rgbxIndex++] = 255;
    }

    let upperIndex = 0;
    const upper = new Uint8Array(3),
      upperleft = new Uint8Array(3);
    for (let y = 1; y < height; y++) {
      left.fill(0);
      upperleft.fill(0);
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          upper[c] = rgbx[upperIndex++];
          let prediction = left[c] + upper[c] - upperleft[c];
          if (prediction < 0) {
            prediction = 0;
          } else if (prediction > 255) {
            prediction = 255;
          }
          const value = data[dataIndex++] + prediction;
          rgbx[rgbxIndex++] = value;
          upperleft[c] = upper[c];
          left[c] = value;
        }
        rgbx[rgbxIndex++] = 255;
        upperIndex++;
      }
    }

    display.blitImage(x, y, width, height, rgbx, 0, false);

    return true;
  }

  _readData(sock: TightSock): Uint8Array | null {
    if (this._len === 0) {
      if (sock.rQwait("TIGHT", 3)) {
        return null;
      }

      let byte = sock.rQshift8();
      this._len = byte & 0x7f;
      if (byte & 0x80) {
        byte = sock.rQshift8();
        this._len |= (byte & 0x7f) << 7;
        if (byte & 0x80) {
          byte = sock.rQshift8();
          this._len |= byte << 14;
        }
      }
    }

    if (sock.rQwait("TIGHT", this._len)) {
      return null;
    }

    const data = sock.rQshiftBytes(this._len, false);
    this._len = 0;

    return data;
  }

  _getScratchBuffer(size: number): Uint8Array {
    if (!this._scratchBuffer || this._scratchBuffer.length < size) {
      this._scratchBuffer = new Uint8Array(size);
    }
    return this._scratchBuffer;
  }
}
