import { describe, expect, test } from "bun:test";
import { computeResizeTarget } from "./resizeSizing";

describe("computeResizeTarget", () => {
  test("follows the viewport exactly with no minimum size", () => {
    const target = computeResizeTarget({
      viewportWidth: 1400,
      viewportHeight: 860,
      dpr: 1,
      minimumSize: null,
    });

    expect(target).toEqual({ width: 1400, height: 860 });
  });

  test("scales the viewport by the device pixel ratio", () => {
    const target = computeResizeTarget({
      viewportWidth: 1024,
      viewportHeight: 768,
      dpr: 2,
      minimumSize: null,
    });

    expect(target).toEqual({ width: 2048, height: 1536 });
  });

  test("shrinking below a prior size is not floored without a minimum", () => {
    const target = computeResizeTarget({
      viewportWidth: 900,
      viewportHeight: 600,
      dpr: 1,
      minimumSize: null,
    });

    expect(target).toEqual({ width: 900, height: 600 });
  });

  test("touch minimum size is enforced per axis", () => {
    const target = computeResizeTarget({
      viewportWidth: 390,
      viewportHeight: 900,
      dpr: 1,
      minimumSize: { width: 1024, height: 768 },
    });

    expect(target).toEqual({ width: 1024, height: 900 });
  });

  test("viewport larger than the minimum wins", () => {
    const target = computeResizeTarget({
      viewportWidth: 1600,
      viewportHeight: 1000,
      dpr: 1,
      minimumSize: { width: 1024, height: 768 },
    });

    expect(target).toEqual({ width: 1600, height: 1000 });
  });

  test("falls back for invalid viewport sizes, minimum sizes, and DPR values", () => {
    const invalidViewportAndDpr = computeResizeTarget({
      viewportWidth: Number.NaN,
      viewportHeight: -20,
      dpr: Number.NaN,
      minimumSize: null,
    });
    expect(invalidViewportAndDpr).toEqual({ width: 1, height: 1 });

    const invalidMinimumIgnored = computeResizeTarget({
      viewportWidth: 100,
      viewportHeight: 120,
      dpr: -1,
      minimumSize: { width: -500, height: Number.NaN },
    });
    expect(invalidMinimumIgnored).toEqual({ width: 100, height: 120 });
  });
});
