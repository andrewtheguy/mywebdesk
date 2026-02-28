import { describe, expect, test } from "bun:test";
import { computeResizeTarget, updateNativeDisplayFloor } from "./resizeSizing";

describe("updateNativeDisplayFloor", () => {
  test("mobile keeps native floor after smaller remote updates", () => {
    const initialFloor = updateNativeDisplayFloor({
      currentNativeDisplaySize: null,
      currentNativeDisplayDprFloor: null,
      nextWidth: 1024,
      nextHeight: 768,
      currentDpr: 3,
      useHiDpiSessionSizing: false,
    });

    expect(initialFloor.nativeDisplaySize).toEqual({
      width: 1024,
      height: 768,
    });
    expect(initialFloor.nativeDisplayDprFloor).toBeNull();

    const unchangedFloor = updateNativeDisplayFloor({
      currentNativeDisplaySize: initialFloor.nativeDisplaySize,
      currentNativeDisplayDprFloor: initialFloor.nativeDisplayDprFloor,
      nextWidth: 390,
      nextHeight: 600,
      currentDpr: 3,
      useHiDpiSessionSizing: false,
    });

    expect(unchangedFloor.nativeDisplaySize).toEqual({
      width: 1024,
      height: 768,
    });
    expect(unchangedFloor.nativeDisplayDprFloor).toBeNull();
  });

  test("keeps floor unchanged when remote update equals native floor", () => {
    const unchangedFloor = updateNativeDisplayFloor({
      currentNativeDisplaySize: { width: 1365, height: 1024 },
      currentNativeDisplayDprFloor: 1.5,
      nextWidth: 1365,
      nextHeight: 1024,
      currentDpr: 1.5,
      useHiDpiSessionSizing: true,
    });

    expect(unchangedFloor.nativeDisplaySize).toEqual({
      width: 1365,
      height: 1024,
    });
    expect(unchangedFloor.nativeDisplayDprFloor).toBe(1.5);
  });

  test("falls back for invalid sizes and DPR values", () => {
    const initializedFromInvalid = updateNativeDisplayFloor({
      currentNativeDisplaySize: null,
      currentNativeDisplayDprFloor: null,
      nextWidth: -50,
      nextHeight: Number.NaN,
      currentDpr: Number.NaN,
      useHiDpiSessionSizing: true,
    });

    expect(initializedFromInvalid.nativeDisplaySize).toEqual({
      width: 1,
      height: 1,
    });
    expect(initializedFromInvalid.nativeDisplayDprFloor).toBe(1);

    const unchangedFromInvalidUpdate = updateNativeDisplayFloor({
      currentNativeDisplaySize: { width: 800, height: 600 },
      currentNativeDisplayDprFloor: 2,
      nextWidth: Number.POSITIVE_INFINITY,
      nextHeight: -1,
      currentDpr: Number.NaN,
      useHiDpiSessionSizing: true,
    });

    expect(unchangedFromInvalidUpdate.nativeDisplaySize).toEqual({
      width: 800,
      height: 600,
    });
    expect(unchangedFromInvalidUpdate.nativeDisplayDprFloor).toBe(2);
  });
});

describe("computeResizeTarget", () => {
  test("mobile floor is enforced at DPR 1", () => {
    const clampedResize = computeResizeTarget({
      viewportWidth: 390,
      viewportHeight: 600,
      dpr: 1,
      nativeDisplaySize: { width: 1024, height: 768 },
      nativeDisplayDprFloor: null,
    });

    expect(clampedResize).toEqual({ width: 1024, height: 768 });
  });

  test("clamps when DPR equals the native floor threshold", () => {
    const clampedAtEqualThreshold = computeResizeTarget({
      viewportWidth: 300,
      viewportHeight: 200,
      dpr: 1.5,
      nativeDisplaySize: { width: 800, height: 600 },
      nativeDisplayDprFloor: 1.5,
    });

    expect(clampedAtEqualThreshold).toEqual({ width: 800, height: 600 });
  });

  test("gates clamping below threshold and clamps above threshold", () => {
    const belowFloorDprResize = computeResizeTarget({
      viewportWidth: 1024,
      viewportHeight: 768,
      dpr: 1,
      nativeDisplaySize: { width: 1365, height: 1024 },
      nativeDisplayDprFloor: 1.5,
    });
    expect(belowFloorDprResize).toEqual({ width: 1024, height: 768 });

    const aboveFloorDprResize = computeResizeTarget({
      viewportWidth: 1024,
      viewportHeight: 768,
      dpr: 2,
      nativeDisplaySize: { width: 1365, height: 1024 },
      nativeDisplayDprFloor: 1.5,
    });
    expect(aboveFloorDprResize).toEqual({ width: 2048, height: 1536 });
  });

  test("falls back for invalid viewport sizes, native sizes, and DPR values", () => {
    const invalidViewportAndDpr = computeResizeTarget({
      viewportWidth: Number.NaN,
      viewportHeight: -20,
      dpr: Number.NaN,
      nativeDisplaySize: null,
      nativeDisplayDprFloor: null,
    });
    expect(invalidViewportAndDpr).toEqual({ width: 1, height: 1 });

    const invalidNativeFloorIgnored = computeResizeTarget({
      viewportWidth: 100,
      viewportHeight: 120,
      dpr: -1,
      nativeDisplaySize: { width: -500, height: Number.NaN },
      nativeDisplayDprFloor: Number.NaN,
    });
    expect(invalidNativeFloorIgnored).toEqual({ width: 100, height: 120 });
  });
});
