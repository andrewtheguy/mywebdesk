/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */
export const encodings = {
  encodingRaw: 0,
  encodingCopyRect: 1,
  encodingTight: 7,

  pseudoEncodingQualityLevel0: -32,
  pseudoEncodingCursor: -239,
  pseudoEncodingDesktopSize: -223,
  pseudoEncodingLastRect: -224,
  pseudoEncodingQEMUExtendedKeyEvent: -258,
  pseudoEncodingDesktopName: -307,
  pseudoEncodingExtendedDesktopSize: -308,
  pseudoEncodingFence: -312,
  pseudoEncodingContinuousUpdates: -313,
  pseudoEncodingCompressLevel0: -256,
  pseudoEncodingExtendedClipboard: 0xc0a1e5ce,
} as const;
