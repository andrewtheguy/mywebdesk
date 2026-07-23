import { expect, test } from "bun:test";
import ZRLEDecoder from "./vendor/novnc/core/decoders/zrle";
import Deflator from "./vendor/novnc/core/deflator";

// Minimal Websock stand-in over a fixed byte buffer, appendable to test
// partial-data resumption.
class FakeSock {
  private buf: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array = new Uint8Array(0)) {
    this.buf = data;
  }

  append(data: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + data.length);
    next.set(this.buf);
    next.set(data, this.buf.length);
    this.buf = next;
  }

  rQwait(_msg: string, num: number, goback = 0): boolean {
    if (this.buf.length - this.pos < num) {
      this.pos -= goback;
      return true;
    }
    return false;
  }

  rQshift32(): number {
    const v =
      (this.buf[this.pos] << 24) |
      (this.buf[this.pos + 1] << 16) |
      (this.buf[this.pos + 2] << 8) |
      this.buf[this.pos + 3];
    this.pos += 4;
    return v >>> 0;
  }

  rQshiftBytes(len: number, _copy = true): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

// Records fills and blits into a flat framebuffer for pixel assertions.
class FakeDisplay {
  fb: Uint8Array;
  fills = 0;
  blits = 0;

  constructor(
    private width: number,
    height: number,
  ) {
    this.fb = new Uint8Array(width * height * 4);
  }

  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number[] | Uint8Array,
  ): void {
    this.fills++;
    for (let py = y; py < y + height; py++) {
      for (let px = x; px < x + width; px++) {
        const i = (py * this.width + px) * 4;
        this.fb[i] = color[0];
        this.fb[i + 1] = color[1];
        this.fb[i + 2] = color[2];
        this.fb[i + 3] = 255;
      }
    }
  }

  blitImage(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    offset: number,
  ): void {
    this.blits++;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const src = offset + (py * width + px) * 4;
        const dst = ((y + py) * this.width + (x + px)) * 4;
        this.fb.set(data.subarray(src, src + 4), dst);
      }
    }
  }

  pixel(x: number, y: number): number[] {
    const i = (y * this.width + x) * 4;
    return Array.from(this.fb.subarray(i, i + 4));
  }
}

function zrleRect(deflator: Deflator, tileStream: number[]): Uint8Array {
  const compressed = deflator.deflate(new Uint8Array(tileStream));
  const rect = new Uint8Array(4 + compressed.length);
  new DataView(rect.buffer).setUint32(0, compressed.length);
  rect.set(compressed, 4);
  return rect;
}

test("solid tile fills the rect", () => {
  const display = new FakeDisplay(8, 8);
  const sock = new FakeSock(zrleRect(new Deflator(), [1, 10, 20, 30]));

  expect(new ZRLEDecoder().decodeRect(0, 0, 8, 8, sock, display, 24)).toBe(
    true,
  );
  expect(display.fills).toBe(1);
  expect(display.pixel(7, 7)).toEqual([10, 20, 30, 255]);
});

test("raw tile blits RGB pixels as opaque RGBA", () => {
  const display = new FakeDisplay(2, 1);
  const sock = new FakeSock(
    zrleRect(new Deflator(), [0, /* pixels */ 1, 2, 3, 4, 5, 6]),
  );

  expect(new ZRLEDecoder().decodeRect(0, 0, 2, 1, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(0, 0)).toEqual([1, 2, 3, 255]);
  expect(display.pixel(1, 0)).toEqual([4, 5, 6, 255]);
});

test("packed palette tile decodes 1-bit rows with byte padding", () => {
  // 9x2 tile, two colors: row 0 alternates starting white, row 1 all black.
  // 9 pixels per row = 2 packed bytes per row (MSB first).
  const display = new FakeDisplay(9, 2);
  const tile = [
    2, // palette size 2
    255,
    255,
    255, // palette[0] white
    0,
    0,
    0, // palette[1] black
    0b01010101,
    0b00000000, // row 0: w b w b w b w b w
    0b11111111,
    0b10000000, // row 1: all black
  ];
  const sock = new FakeSock(zrleRect(new Deflator(), tile));

  expect(new ZRLEDecoder().decodeRect(0, 0, 9, 2, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(0, 0)).toEqual([255, 255, 255, 255]);
  expect(display.pixel(1, 0)).toEqual([0, 0, 0, 255]);
  expect(display.pixel(8, 0)).toEqual([255, 255, 255, 255]);
  expect(display.pixel(0, 1)).toEqual([0, 0, 0, 255]);
  expect(display.pixel(8, 1)).toEqual([0, 0, 0, 255]);
});

test("packed palette tile uses 4-bit indices for larger palettes", () => {
  // 3x1 tile with a 5-color palette: indices 4, 0, 2 (two per byte).
  const display = new FakeDisplay(3, 1);
  const palette = [
    0,
    0,
    1,
    0,
    0,
    2,
    0,
    0,
    3,
    0,
    0,
    4,
    0,
    0,
    5, // colors 1..5 in blue
  ];
  const tile = [5, ...palette, 0x40, 0x20];
  const sock = new FakeSock(zrleRect(new Deflator(), tile));

  expect(new ZRLEDecoder().decodeRect(0, 0, 3, 1, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(0, 0)).toEqual([0, 0, 5, 255]);
  expect(display.pixel(1, 0)).toEqual([0, 0, 1, 255]);
  expect(display.pixel(2, 0)).toEqual([0, 0, 3, 255]);
});

test("plain RLE tile decodes runs", () => {
  // 4x1: red x3 (run byte 2), then green x1 (run byte 0).
  const display = new FakeDisplay(4, 1);
  const tile = [128, 200, 0, 0, 2, 0, 200, 0, 0];
  const sock = new FakeSock(zrleRect(new Deflator(), tile));

  expect(new ZRLEDecoder().decodeRect(0, 0, 4, 1, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(2, 0)).toEqual([200, 0, 0, 255]);
  expect(display.pixel(3, 0)).toEqual([0, 200, 0, 255]);
});

test("palette RLE tile handles 255-continued run lengths", () => {
  // 64x5 = 320 pixels: run of 300 of palette[1] (0x80|1, 255, 44) then a
  // run of 20 of palette[0] (0x80|0, 19).
  const display = new FakeDisplay(64, 5);
  const tile = [130, 9, 9, 9, 7, 7, 7, 0x81, 255, 44, 0x80, 19];
  const sock = new FakeSock(zrleRect(new Deflator(), tile));

  expect(new ZRLEDecoder().decodeRect(0, 0, 64, 5, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(0, 0)).toEqual([7, 7, 7, 255]);
  expect(display.pixel(43, 4)).toEqual([7, 7, 7, 255]); // pixel 299
  expect(display.pixel(44, 4)).toEqual([9, 9, 9, 255]); // pixel 300
  expect(display.pixel(63, 4)).toEqual([9, 9, 9, 255]);
});

test("palette RLE single-pixel entries (no run-length byte)", () => {
  const display = new FakeDisplay(2, 1);
  const tile = [130, 1, 1, 1, 2, 2, 2, 1, 0]; // pixels: palette[1], palette[0]
  const sock = new FakeSock(zrleRect(new Deflator(), tile));

  expect(new ZRLEDecoder().decodeRect(0, 0, 2, 1, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(0, 0)).toEqual([2, 2, 2, 255]);
  expect(display.pixel(1, 0)).toEqual([1, 1, 1, 255]);
});

test("rect wider than a tile decodes multiple tiles in order", () => {
  // 65x1 rect = one 64px solid tile + one 1px solid tile.
  const display = new FakeDisplay(65, 1);
  const sock = new FakeSock(
    zrleRect(new Deflator(), [1, 100, 0, 0, 1, 0, 100, 0]),
  );

  expect(new ZRLEDecoder().decodeRect(0, 0, 65, 1, sock, display, 24)).toBe(
    true,
  );
  expect(display.pixel(63, 0)).toEqual([100, 0, 0, 255]);
  expect(display.pixel(64, 0)).toEqual([0, 100, 0, 255]);
});

test("zlib stream continues across rects", () => {
  // Two rects compressed as continuations of one deflate stream, as a real
  // server produces them. A decoder that resets its inflator per rect fails.
  const display = new FakeDisplay(4, 4);
  const deflator = new Deflator();
  const decoder = new ZRLEDecoder();

  const rect1 = zrleRect(deflator, [1, 10, 0, 0]);
  const rect2 = zrleRect(deflator, [1, 0, 10, 0]);

  const sock = new FakeSock(rect1);
  expect(decoder.decodeRect(0, 0, 4, 2, sock, display, 24)).toBe(true);
  sock.append(rect2);
  expect(decoder.decodeRect(0, 2, 4, 2, sock, display, 24)).toBe(true);

  expect(display.pixel(0, 0)).toEqual([10, 0, 0, 255]);
  expect(display.pixel(3, 3)).toEqual([0, 10, 0, 255]);
});

test("returns false until the whole rect arrived, then resumes cleanly", () => {
  const display = new FakeDisplay(8, 8);
  const decoder = new ZRLEDecoder();
  const rect = zrleRect(new Deflator(), [1, 1, 2, 3]);

  const sock = new FakeSock(rect.subarray(0, 2)); // not even the length yet
  expect(decoder.decodeRect(0, 0, 8, 8, sock, display, 24)).toBe(false);

  sock.append(rect.subarray(2, 6)); // length + partial payload
  expect(decoder.decodeRect(0, 0, 8, 8, sock, display, 24)).toBe(false);

  sock.append(rect.subarray(6));
  expect(decoder.decodeRect(0, 0, 8, 8, sock, display, 24)).toBe(true);
  expect(display.pixel(4, 4)).toEqual([1, 2, 3, 255]);
});

test("corrupt run overflowing the tile throws instead of smearing", () => {
  const display = new FakeDisplay(2, 1);
  // Plain RLE: run of 3 in a 2-pixel tile.
  const sock = new FakeSock(zrleRect(new Deflator(), [128, 5, 5, 5, 2]));

  expect(() =>
    new ZRLEDecoder().decodeRect(0, 0, 2, 1, sock, display, 24),
  ).toThrow();
});
