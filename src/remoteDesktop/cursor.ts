export interface RemoteCursorImage {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Pointer shape used whenever the server has not provided a usable one: a
 * black dot with a white ring, hotspot at its center. macOS Screen Sharing
 * sends no cursor rect at the login window and hides the pointer while
 * typing; without a fallback the pointer position would be invisible there.
 */
export const FALLBACK_CURSOR: RemoteCursorImage = buildFallbackCursor();

function buildFallbackCursor(): RemoteCursorImage {
  const size = 11;
  const center = (size - 1) / 2;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - center, y - center);
      if (r > 4.6) continue; // transparent corner
      const i = (y * size + x) * 4;
      const white = r > 2.8 ? 255 : 0;
      rgba[i] = white;
      rgba[i + 1] = white;
      rgba[i + 2] = white;
      rgba[i + 3] = 255;
    }
  }
  return { width: size, height: size, hotX: center, hotY: center, rgba };
}

/**
 * Decode a RichCursor pseudo-encoding rect payload into an RGBA image.
 *
 * `pixels` holds width×height cursor pixels in the negotiated 32bpp
 * little-endian red-shift-0 pixel format, i.e. RGBX byte order on the wire.
 * `mask` is a 1-bit-per-pixel visibility bitmap, MSB first, with each row
 * padded to a whole byte.
 *
 * Returns null when the server hides the pointer: an empty rect, or a mask
 * with no visible pixel.
 */
export function decodeCursorRect(
  width: number,
  height: number,
  hotX: number,
  hotY: number,
  pixels: Uint8Array,
  mask: Uint8Array,
): RemoteCursorImage | null {
  if (width < 1 || height < 1) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  const maskStride = Math.ceil(width / 8);
  let visible = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const opaque = (mask[y * maskStride + (x >> 3)] >> (7 - (x & 7))) & 1;
      rgba[i * 4] = pixels[i * 4];
      rgba[i * 4 + 1] = pixels[i * 4 + 1];
      rgba[i * 4 + 2] = pixels[i * 4 + 2];
      rgba[i * 4 + 3] = opaque ? 255 : 0;
      if (opaque) visible = true;
    }
  }

  return visible ? { width, height, hotX, hotY, rgba } : null;
}

/**
 * Build a CSS `cursor` value for a decoded cursor image, scaled so the
 * pointer matches the on-screen size of the framebuffer it belongs to
 * (`scale` = displayed CSS pixels per framebuffer pixel).
 */
export function cursorCssValue(
  cursor: RemoteCursorImage,
  scale: number,
): string {
  const source = document.createElement("canvas");
  source.width = cursor.width;
  source.height = cursor.height;
  const sourceCtx = source.getContext("2d");
  if (!sourceCtx) return "default";
  sourceCtx.putImageData(
    new ImageData(cursor.rgba, cursor.width, cursor.height),
    0,
    0,
  );

  const cssWidth = Math.max(1, Math.round(cursor.width * scale));
  const cssHeight = Math.max(1, Math.round(cursor.height * scale));
  let image = source;
  if (cssWidth !== cursor.width || cssHeight !== cursor.height) {
    image = document.createElement("canvas");
    image.width = cssWidth;
    image.height = cssHeight;
    const imageCtx = image.getContext("2d");
    if (!imageCtx) return "default";
    imageCtx.drawImage(source, 0, 0, cssWidth, cssHeight);
  }

  const hotX = clamp(
    Math.round((cursor.hotX * cssWidth) / cursor.width),
    0,
    cssWidth - 1,
  );
  const hotY = clamp(
    Math.round((cursor.hotY * cssHeight) / cursor.height),
    0,
    cssHeight - 1,
  );
  return `url(${image.toDataURL()}) ${hotX} ${hotY}, default`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
