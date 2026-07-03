import { expect, test } from "bun:test";
import { toRfbButtonMask } from "./rfbInput";

test("empty state maps to no buttons", () => {
  expect(toRfbButtonMask({})).toBe(0);
});

test("individual buttons map to RFB mask bits", () => {
  expect(toRfbButtonMask({ left: true })).toBe(1);
  expect(toRfbButtonMask({ middle: true })).toBe(2);
  expect(toRfbButtonMask({ right: true })).toBe(4);
  expect(toRfbButtonMask({ up: true })).toBe(8);
  expect(toRfbButtonMask({ down: true })).toBe(16);
});

test("buttons combine into a single mask", () => {
  expect(toRfbButtonMask({ left: true, right: true })).toBe(5);
  expect(
    toRfbButtonMask({
      left: true,
      middle: true,
      right: true,
      up: true,
      down: true,
    }),
  ).toBe(31);
});

test("explicit false flags contribute nothing", () => {
  expect(toRfbButtonMask({ left: false, middle: false, right: true })).toBe(4);
});
