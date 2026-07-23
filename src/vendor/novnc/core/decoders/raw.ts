/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

interface RawSock {
  rQwait(msg: string, num: number): boolean;
  rQshiftBytes(len: number, copy?: boolean): Uint8Array;
}

interface RawDisplay {
  blitImage(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    offset: number,
  ): void;
}

export default class RawDecoder {
  private _lines: number;

  constructor() {
    this._lines = 0;
  }

  decodeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: RawSock,
    display: RawDisplay,
    depth: number,
  ): boolean {
    if (width === 0 || height === 0) {
      return true;
    }

    if (this._lines === 0) {
      this._lines = height;
    }

    const pixelSize = depth === 8 ? 1 : 4;
    const bytesPerLine = width * pixelSize;

    while (this._lines > 0) {
      if (sock.rQwait("RAW", bytesPerLine)) {
        return false;
      }

      const curY = y + (height - this._lines);

      let data = sock.rQshiftBytes(bytesPerLine, false);

      // Convert data if needed
      if (depth === 8) {
        const newdata = new Uint8Array(width * 4);
        for (let i = 0; i < width; i++) {
          newdata[i * 4 + 0] = (((data[i] >> 0) & 0x3) * 255) / 3;
          newdata[i * 4 + 1] = (((data[i] >> 2) & 0x3) * 255) / 3;
          newdata[i * 4 + 2] = (((data[i] >> 4) & 0x3) * 255) / 3;
          newdata[i * 4 + 3] = 255;
        }
        data = newdata;
      }

      // Max sure the image is fully opaque
      for (let i = 0; i < width; i++) {
        data[i * 4 + 3] = 255;
      }

      display.blitImage(x, curY, width, 1, data, 0);
      this._lines--;
    }

    return true;
  }
}
