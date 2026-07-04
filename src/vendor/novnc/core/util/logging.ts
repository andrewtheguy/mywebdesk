/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

/*
 * Logging/debug routines. The level is fixed at 'warn' (nothing ever
 * called initLogging with another level, so the switchable machinery
 * was dead code).
 */

/* eslint-disable no-console */
export const Debug = () => {};
export const Info = () => {};
export const Warn = console.warn.bind(console);
export const Error = console.error.bind(console);
/* eslint-enable no-console */
