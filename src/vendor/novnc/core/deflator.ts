/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2020 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import { Z_FULL_FLUSH, ZStream, zlibDeflate, zlibDeflateInit } from "pako";

const Z_DEFAULT_COMPRESSION = -1;

type RfbZStream = Omit<ZStream, "input" | "output"> & {
  input: Uint8Array | null;
  output: Uint8Array;
};

export default class Deflator {
  private strm: RfbZStream;
  private chunkSize: number;
  private outputBuffer: Uint8Array;

  constructor() {
    this.strm = new ZStream() as RfbZStream;
    this.chunkSize = 1024 * 10 * 10;
    this.outputBuffer = new Uint8Array(this.chunkSize);

    zlibDeflateInit(this.strm as ZStream, Z_DEFAULT_COMPRESSION);
  }

  deflate(inData: Uint8Array): Uint8Array {
    this.strm.input = inData;
    this.strm.avail_in = this.strm.input.length;
    this.strm.next_in = 0;
    this.strm.output = this.outputBuffer;
    this.strm.avail_out = this.chunkSize;
    this.strm.next_out = 0;

    let lastRet = zlibDeflate(this.strm as ZStream, Z_FULL_FLUSH);
    let outData = new Uint8Array(
      this.strm.output.buffer,
      0,
      this.strm.next_out,
    );

    if (lastRet < 0) {
      throw new Error("zlib deflate failed");
    }

    if (this.strm.avail_in > 0) {
      // Read chunks until done

      const chunks = [outData];
      let totalLen = outData.length;
      do {
        this.strm.output = new Uint8Array(this.chunkSize);
        this.strm.next_out = 0;
        this.strm.avail_out = this.chunkSize;

        lastRet = zlibDeflate(this.strm as ZStream, Z_FULL_FLUSH);

        if (lastRet < 0) {
          throw new Error("zlib deflate failed");
        }

        const chunk = new Uint8Array(
          this.strm.output.buffer,
          0,
          this.strm.next_out,
        );
        totalLen += chunk.length;
        chunks.push(chunk);
      } while (this.strm.avail_in > 0);

      // Combine chunks into a single data

      const newData = new Uint8Array(totalLen);
      let offset = 0;

      for (let i = 0; i < chunks.length; i++) {
        newData.set(chunks[i], offset);
        offset += chunks[i].length;
      }

      outData = newData;
    }

    this.strm.input = null;
    this.strm.avail_in = 0;
    this.strm.next_in = 0;

    return outData;
  }
}
