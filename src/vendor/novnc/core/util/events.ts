/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2018 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

/*
 * Event helpers
 */

export function stopEvent(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
}
