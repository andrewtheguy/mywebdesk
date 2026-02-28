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

function normalizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return Math.max(1, Math.round(fallback));
  }
  return Math.max(1, Math.round(value));
}

function normalizeDpr(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function normalizeDprFloor(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeDisplaySize(value: DisplaySize | null): DisplaySize | null {
  if (!value) return null;
  if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) {
    return null;
  }
  if (value.width <= 0 || value.height <= 0) return null;
  return {
    width: Math.max(1, Math.round(value.width)),
    height: Math.max(1, Math.round(value.height)),
  };
}

export function computeResizeTarget({
  viewportWidth,
  viewportHeight,
  dpr,
  nativeDisplaySize,
  nativeDisplayDprFloor,
}: ComputeResizeTargetParams): DisplaySize {
  const safeDpr = normalizeDpr(dpr);
  const safeViewportWidth = normalizeDimension(viewportWidth, 1);
  const safeViewportHeight = normalizeDimension(viewportHeight, 1);
  const safeNativeDisplaySize = normalizeDisplaySize(nativeDisplaySize);
  const safeNativeDisplayDprFloor = normalizeDprFloor(nativeDisplayDprFloor);
  let width = Math.max(1, Math.round(safeViewportWidth * safeDpr));
  let height = Math.max(1, Math.round(safeViewportHeight * safeDpr));

  if (
    safeNativeDisplaySize &&
    (safeNativeDisplayDprFloor == null || safeDpr >= safeNativeDisplayDprFloor)
  ) {
    width = Math.max(safeNativeDisplaySize.width, width);
    height = Math.max(safeNativeDisplaySize.height, height);
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
  const safeCurrentNativeDisplaySize = normalizeDisplaySize(
    currentNativeDisplaySize,
  );
  const safeCurrentNativeDisplayDprFloor = normalizeDprFloor(
    currentNativeDisplayDprFloor,
  );
  const safeCurrentDpr = normalizeDpr(currentDpr);
  const safeNextWidth = normalizeDimension(
    nextWidth,
    safeCurrentNativeDisplaySize?.width ?? 1,
  );
  const safeNextHeight = normalizeDimension(
    nextHeight,
    safeCurrentNativeDisplaySize?.height ?? 1,
  );

  if (!safeCurrentNativeDisplaySize) {
    return {
      nativeDisplaySize: { width: safeNextWidth, height: safeNextHeight },
      nativeDisplayDprFloor: useHiDpiSessionSizing ? safeCurrentDpr : null,
    };
  }

  if (
    useHiDpiSessionSizing &&
    (safeNextWidth < safeCurrentNativeDisplaySize.width ||
      safeNextHeight < safeCurrentNativeDisplaySize.height)
  ) {
    return {
      nativeDisplaySize: {
        width: Math.min(safeCurrentNativeDisplaySize.width, safeNextWidth),
        height: Math.min(safeCurrentNativeDisplaySize.height, safeNextHeight),
      },
      nativeDisplayDprFloor: Math.min(
        safeCurrentNativeDisplayDprFloor ?? Number.POSITIVE_INFINITY,
        safeCurrentDpr,
      ),
    };
  }

  return {
    nativeDisplaySize: safeCurrentNativeDisplaySize,
    nativeDisplayDprFloor: safeCurrentNativeDisplayDprFloor,
  };
}
