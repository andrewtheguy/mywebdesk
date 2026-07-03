export interface MouseButtonState {
  left?: boolean;
  middle?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
}

// RFB PointerEvent button mask: 1=left, 2=middle, 4=right,
// 8=wheel-up, 16=wheel-down, 32=wheel-left, 64=wheel-right.
export function toRfbButtonMask(state: MouseButtonState): number {
  return (
    (state.left ? 1 : 0) |
    (state.middle ? 2 : 0) |
    (state.right ? 4 : 0) |
    (state.up ? 8 : 0) |
    (state.down ? 16 : 0)
  );
}
