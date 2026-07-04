/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

interface CopyRectSock {
    rQwait(msg: string, num: number): boolean;
    rQshift16(): number;
}

interface CopyRectDisplay {
    copyImage(oldX: number, oldY: number, newX: number, newY: number, width: number, height: number): void;
}

export default class CopyRectDecoder {
    decodeRect(x: number, y: number, width: number, height: number, sock: CopyRectSock, display: CopyRectDisplay, depth: number): boolean {
        if (sock.rQwait("COPYRECT", 4)) {
            return false;
        }

        let deltaX = sock.rQshift16();
        let deltaY = sock.rQshift16();

        if ((width === 0) || (height === 0)) {
            return true;
        }

        display.copyImage(deltaX, deltaY, x, y, width, height);

        return true;
    }
}
