/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2020 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import {
    Z_NO_FLUSH,
    ZStream,
    zlibInflate,
    zlibInflateInit,
    zlibInflateReset,
} from "pako";

type RfbZStream = Omit<ZStream, "input" | "output"> & {
    input: Uint8Array | null;
    output: Uint8Array;
};

export default class Inflate {
    private strm: RfbZStream;
    private chunkSize: number;

    constructor() {
        this.strm = new ZStream() as RfbZStream;
        this.chunkSize = 1024 * 10 * 10;
        this.strm.output = new Uint8Array(this.chunkSize);

        zlibInflateInit(this.strm as ZStream);
    }

    setInput(data: Uint8Array | null) {
        if (!data) {
            //FIXME: flush remaining data.
            /* eslint-disable camelcase */
            this.strm.input = null;
            this.strm.avail_in = 0;
            this.strm.next_in = 0;
        } else {
            this.strm.input = data;
            this.strm.avail_in = this.strm.input.length;
            this.strm.next_in = 0;
            /* eslint-enable camelcase */
        }
    }

    inflate(expected: number): Uint8Array {
        // resize our output buffer if it's too small
        // (we could just use multiple chunks, but that would cause an extra
        // allocation each time to flatten the chunks)
        if (expected > this.chunkSize) {
            this.chunkSize = expected;
            this.strm.output = new Uint8Array(this.chunkSize);
        }

        /* eslint-disable camelcase */
        this.strm.next_out = 0;
        this.strm.avail_out = expected;
        /* eslint-enable camelcase */

        let ret = zlibInflate(this.strm as ZStream, Z_NO_FLUSH);
        if (ret < 0) {
            throw new Error("zlib inflate failed");
        }

        if (this.strm.next_out != expected) {
            throw new Error("Incomplete zlib block");
        }

        return new Uint8Array(this.strm.output.buffer, 0, this.strm.next_out);
    }

    reset(): void {
        zlibInflateReset(this.strm as ZStream);
    }
}
