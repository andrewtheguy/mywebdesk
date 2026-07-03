import RFB from "@novnc/novnc";

// RFB pseudo-encoding constants (stable protocol values, mirrored from
// noVNC's core/encodings.js).
const PSEUDO_ENCODING_CURSOR = -239;
const PSEUDO_ENCODING_VMWARE_CURSOR = 0x574d5664;

export interface FbSize {
  width: number;
  height: number;
}

// RFB subclass that makes exact HiDPI framebuffer sizing possible. Stock
// noVNC sizes the remote desktop from the container's CSS pixel size; this
// subclass lets the caller inject a device-pixel target instead, keeps our
// own display scale (stock forces 1.0 when scaleViewport is off), announces
// framebuffer resizes via a custom "fbresize" event, and keeps the cursor
// rendered server-side (our input overlay would hide noVNC's CSS cursor).
//
// The overridden/accessed underscore members are internal noVNC API, valid
// only for the exact pinned version (1.7.0). NOTE: the RFB constructor runs
// _connect() synchronously, before subclass field initializers — every
// override below must tolerate its subclass state being undefined.
export class HiDpiRFB extends RFB {
  // Injected by useVnc: returns the desired framebuffer size in device px.
  computeTargetSize: (() => FbSize) | undefined;

  private _baseScale: number | undefined;

  // Sole source for setDesktopSize requests (_requestRemoteResize).
  protected override _screenSize(): { w: number; h: number } {
    if (!this.computeTargetSize) return super._screenSize();
    const { width, height } = this.computeTargetSize();
    return { w: width, h: height };
  }

  // Stock impl forces display.scale = 1.0 when scaleViewport is off, and is
  // re-run by noVNC's ResizeObserver and on every framebuffer resize — so we
  // must own it to keep our fit/zoom scale applied.
  protected override _updateScale(): void {
    this._display.scale = this._baseScale ?? 1;
  }

  setBaseScale(scale: number): void {
    this._baseScale = scale;
    this._display.scale = scale;
  }

  protected override _resize(width: number, height: number): void {
    super._resize(width, height);
    this.dispatchEvent(
      new CustomEvent<FbSize>("fbresize", { detail: { width, height } }),
    );
  }

  // Advertising cursor pseudo-encodings makes the server stop drawing the
  // cursor into the framebuffer (noVNC would show it as a CSS cursor on its
  // canvas, which sits under our input overlay and is therefore invisible).
  // Filter them out so the cursor stays composited server-side.
  protected override _sendEncodings(): void {
    const messages = RFB.messages;
    const originalClientEncodings = messages.clientEncodings;
    messages.clientEncodings = (sock, encs) => {
      originalClientEncodings.call(
        messages,
        sock,
        encs.filter(
          (enc) =>
            enc !== PSEUDO_ENCODING_CURSOR &&
            enc !== PSEUDO_ENCODING_VMWARE_CURSOR,
        ),
      );
    };
    try {
      super._sendEncodings();
    } finally {
      messages.clientEncodings = originalClientEncodings;
    }
  }

  // Safe to call repeatedly: noVNC rate-limits to one pending request per
  // 100ms and no-ops when the framebuffer already matches the target.
  requestResize(): void {
    this._requestRemoteResize();
  }

  sendPointer(x: number, y: number, buttonMask: number): void {
    if (this._rfbConnectionState !== "connected") return;
    // Pointer coordinates are unsigned 16-bit on the wire; clamp to the
    // framebuffer so letterbox-area events can't wrap around.
    const maxX = Math.max(0, this._fbWidth - 1);
    const maxY = Math.max(0, this._fbHeight - 1);
    RFB.messages.pointerEvent(
      this._sock,
      Math.min(maxX, Math.max(0, Math.round(x))),
      Math.min(maxY, Math.max(0, Math.round(y))),
      buttonMask,
    );
  }

  get connected(): boolean {
    return this._rfbConnectionState === "connected";
  }

  get fbSize(): FbSize {
    return { width: this._fbWidth, height: this._fbHeight };
  }

  get canvasElement(): HTMLCanvasElement {
    return this._canvas;
  }

  get screenElement(): HTMLDivElement {
    return this._screen;
  }
}
