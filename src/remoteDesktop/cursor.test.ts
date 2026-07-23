import { expect, test } from "bun:test";
import { decodeCursorRect } from "./cursor";

function rgbxPixels(colors: [number, number, number][]): Uint8Array {
  const pixels = new Uint8Array(colors.length * 4);
  colors.forEach(([r, g, b], i) => {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 0x7f; // padding byte the decoder must ignore
  });
  return pixels;
}

test("decodes RGBX pixels and applies the visibility mask", () => {
  // 2x2 cursor: top-left and bottom-right visible.
  const pixels = rgbxPixels([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [10, 20, 30],
  ]);
  const mask = new Uint8Array([0b10000000, 0b01000000]);

  const cursor = decodeCursorRect(2, 2, 1, 0, pixels, mask);
  expect(cursor).not.toBeNull();
  if (!cursor) return;

  expect(cursor.width).toBe(2);
  expect(cursor.height).toBe(2);
  expect(cursor.hotX).toBe(1);
  expect(cursor.hotY).toBe(0);
  expect(Array.from(cursor.rgba)).toEqual([
    255,
    0,
    0,
    255, //
    0,
    255,
    0,
    0, //
    0,
    0,
    255,
    0, //
    10,
    20,
    30,
    255,
  ]);
});

test("mask rows are byte-padded and MSB-first", () => {
  // 9x1 cursor: only the last pixel (bit 0 of the second mask byte's MSB)
  // is visible, exercising the row stride of ceil(9/8) = 2 bytes.
  const colors: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) colors.push([i, i, i]);
  const pixels = rgbxPixels(colors);
  const mask = new Uint8Array([0b00000000, 0b10000000]);

  const cursor = decodeCursorRect(9, 1, 0, 0, pixels, mask);
  expect(cursor).not.toBeNull();
  if (!cursor) return;

  for (let i = 0; i < 9; i++) {
    expect(cursor.rgba[i * 4 + 3]).toBe(i === 8 ? 255 : 0);
  }
});

test("empty rect means the pointer is hidden", () => {
  expect(
    decodeCursorRect(0, 0, 0, 0, new Uint8Array(0), new Uint8Array(0)),
  ).toBeNull();
});

test("fully masked cursor means the pointer is hidden", () => {
  const pixels = rgbxPixels([
    [255, 255, 255],
    [255, 255, 255],
  ]);
  const mask = new Uint8Array([0b00000000]);
  expect(decodeCursorRect(2, 1, 0, 0, pixels, mask)).toBeNull();
});
