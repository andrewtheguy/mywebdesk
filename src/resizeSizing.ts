export interface DisplaySize {
  width: number;
  height: number;
}

export interface NativeDisplayFloorState {
  nativeDisplaySize: DisplaySize | null;
  nativeDisplayDprFloor: number | null;
}

interface ComputeResizeTargetParams {
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  nativeDisplaySize: DisplaySize | null;
  nativeDisplayDprFloor: number | null;
}

interface UpdateNativeDisplayFloorParams {
  currentNativeDisplaySize: DisplaySize | null;
  currentNativeDisplayDprFloor: number | null;
  nextWidth: number;
  nextHeight: number;
  currentDpr: number;
  useHiDpiSessionSizing: boolean;
}

export function computeResizeTarget({
  viewportWidth,
  viewportHeight,
  dpr,
  nativeDisplaySize,
  nativeDisplayDprFloor,
}: ComputeResizeTargetParams): DisplaySize {
  let width = Math.max(1, Math.round(viewportWidth * dpr));
  let height = Math.max(1, Math.round(viewportHeight * dpr));

  if (
    nativeDisplaySize &&
    (nativeDisplayDprFloor == null || dpr >= nativeDisplayDprFloor)
  ) {
    width = Math.max(nativeDisplaySize.width, width);
    height = Math.max(nativeDisplaySize.height, height);
  }

  return { width, height };
}

export function updateNativeDisplayFloor({
  currentNativeDisplaySize,
  currentNativeDisplayDprFloor,
  nextWidth,
  nextHeight,
  currentDpr,
  useHiDpiSessionSizing,
}: UpdateNativeDisplayFloorParams): NativeDisplayFloorState {
  if (!currentNativeDisplaySize) {
    return {
      nativeDisplaySize: { width: nextWidth, height: nextHeight },
      nativeDisplayDprFloor: useHiDpiSessionSizing ? currentDpr : null,
    };
  }

  if (
    useHiDpiSessionSizing &&
    (nextWidth < currentNativeDisplaySize.width ||
      nextHeight < currentNativeDisplaySize.height)
  ) {
    return {
      nativeDisplaySize: {
        width: Math.min(currentNativeDisplaySize.width, nextWidth),
        height: Math.min(currentNativeDisplaySize.height, nextHeight),
      },
      nativeDisplayDprFloor: Math.min(
        currentNativeDisplayDprFloor ?? Number.POSITIVE_INFINITY,
        currentDpr,
      ),
    };
  }

  return {
    nativeDisplaySize: currentNativeDisplaySize,
    nativeDisplayDprFloor: currentNativeDisplayDprFloor,
  };
}
