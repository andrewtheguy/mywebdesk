/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 * Browser feature support detection
 */

/* OS */

export function isMac(): boolean {
  return !!/mac/i.exec(navigator.platform);
}

export function isWindows(): boolean {
  return !!/win/i.exec(navigator.platform);
}

export function isIOS(): boolean {
  return (
    !!/ipad/i.exec(navigator.platform) ||
    !!/iphone/i.exec(navigator.platform) ||
    !!/ipod/i.exec(navigator.platform)
  );
}
