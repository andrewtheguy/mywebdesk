import { expect, test } from "bun:test";
import { computeResizeTarget, updateNativeDisplayFloor } from "./resizeSizing";

test("mobile keeps native floor and enforces min size after smaller remote updates", () => {
  const initialFloor = updateNativeDisplayFloor({
    currentNativeDisplaySize: null,
    currentNativeDisplayDprFloor: null,
    nextWidth: 1024,
    nextHeight: 768,
    currentDpr: 3,
    useHiDpiSessionSizing: false,
  });

  expect(initialFloor.nativeDisplaySize).toEqual({ width: 1024, height: 768 });
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

  const clampedResize = computeResizeTarget({
    viewportWidth: 390,
    viewportHeight: 600,
    dpr: 1,
    nativeDisplaySize: unchangedFloor.nativeDisplaySize,
    nativeDisplayDprFloor: unchangedFloor.nativeDisplayDprFloor,
  });

  expect(clampedResize).toEqual({ width: 1024, height: 768 });
});

test("desktop HiDPI can lower floor at lower DPR and gate clamping by DPR floor", () => {
  const initialFloor = updateNativeDisplayFloor({
    currentNativeDisplaySize: null,
    currentNativeDisplayDprFloor: null,
    nextWidth: 2048,
    nextHeight: 1536,
    currentDpr: 2,
    useHiDpiSessionSizing: true,
  });

  expect(initialFloor.nativeDisplaySize).toEqual({
    width: 2048,
    height: 1536,
  });
  expect(initialFloor.nativeDisplayDprFloor).toBe(2);

  const loweredFloor = updateNativeDisplayFloor({
    currentNativeDisplaySize: initialFloor.nativeDisplaySize,
    currentNativeDisplayDprFloor: initialFloor.nativeDisplayDprFloor,
    nextWidth: 1365,
    nextHeight: 1024,
    currentDpr: 1.5,
    useHiDpiSessionSizing: true,
  });

  expect(loweredFloor.nativeDisplaySize).toEqual({ width: 1365, height: 1024 });
  expect(loweredFloor.nativeDisplayDprFloor).toBe(1.5);

  const belowFloorDprResize = computeResizeTarget({
    viewportWidth: 1024,
    viewportHeight: 768,
    dpr: 1,
    nativeDisplaySize: loweredFloor.nativeDisplaySize,
    nativeDisplayDprFloor: loweredFloor.nativeDisplayDprFloor,
  });
  expect(belowFloorDprResize).toEqual({ width: 1024, height: 768 });

  const aboveFloorDprResize = computeResizeTarget({
    viewportWidth: 1024,
    viewportHeight: 768,
    dpr: 2,
    nativeDisplaySize: loweredFloor.nativeDisplaySize,
    nativeDisplayDprFloor: loweredFloor.nativeDisplayDprFloor,
  });
  expect(aboveFloorDprResize).toEqual({ width: 2048, height: 1536 });
});
