export interface DisplaySize {
  width: number;
  height: number;
}

interface ComputeResizeTargetParams {
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  minimumSize: DisplaySize | null;
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
  minimumSize,
}: ComputeResizeTargetParams): DisplaySize {
  const safeDpr = normalizeDpr(dpr);
  const safeViewportWidth = normalizeDimension(viewportWidth, 1);
  const safeViewportHeight = normalizeDimension(viewportHeight, 1);
  const safeMinimumSize = normalizeDisplaySize(minimumSize);
  let width = Math.max(1, Math.round(safeViewportWidth * safeDpr));
  let height = Math.max(1, Math.round(safeViewportHeight * safeDpr));

  if (safeMinimumSize) {
    width = Math.max(safeMinimumSize.width, width);
    height = Math.max(safeMinimumSize.height, height);
  }

  return { width, height };
}
