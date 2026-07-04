/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import * as Log from './util/logging';

// A deferred draw operation queued for in-order rendering. Discriminated on
// `type` so _scanRenderQ() narrows the payload per case.
type RenderAction =
    | { type: 'flip' }
    | { type: 'copy'; oldX: number; oldY: number; x: number; y: number; width: number; height: number }
    | { type: 'fill'; x: number; y: number; width: number; height: number; color: number[] | Uint8Array }
    | { type: 'blit'; data: Uint8Array; x: number; y: number; width: number; height: number }
    | { type: 'img'; img: HTMLImageElement; x: number; y: number; width: number; height: number };

declare global {
    // Expando the render queue hangs on a pending <img> so its 'load' handler
    // (which runs with `this` bound to the image) can reach the Display.
    interface HTMLImageElement {
        _noVNCDisplay?: Display;
    }
}

export default class Display {
    private _target: HTMLCanvasElement;
    private _targetCtx!: CanvasRenderingContext2D;
    private _backbuffer!: HTMLCanvasElement;
    private _drawCtx!: CanvasRenderingContext2D;
    private _renderQ: RenderAction[];
    private _flushPromise: Promise<void> | null;
    private _flushResolve: (() => void) | null;
    private _fbWidth: number;
    private _fbHeight: number;
    private _prevDrawStyle: string;
    private _damageBounds!: { left: number; top: number; right: number; bottom: number };
    private _scale!: number;

    constructor(target: HTMLCanvasElement) {
        this._renderQ = [];  // queue drawing actions for in-oder rendering
        this._flushPromise = null;
        this._flushResolve = null;

        // the full frame buffer (logical canvas) size
        this._fbWidth = 0;
        this._fbHeight = 0;

        this._prevDrawStyle = "";

        Log.Debug(">> Display.constructor");

        // The visible canvas
        this._target = target;

        if (!this._target) {
            throw new Error("Target must be set");
        }

        if (typeof this._target === 'string') {
            throw new Error('target must be a DOM element');
        }

        if (!this._target.getContext) {
            throw new Error("no getContext method");
        }

        this._targetCtx = this._target.getContext('2d')!;

        // The hidden canvas, where we do the actual rendering
        this._backbuffer = document.createElement('canvas');
        this._drawCtx = this._backbuffer.getContext('2d')!;

        this._damageBounds = { left: 0, top: 0,
                               right: this._backbuffer.width,
                               bottom: this._backbuffer.height };

        Log.Debug("User Agent: " + navigator.userAgent);

        Log.Debug("<< Display.constructor");

        // ===== PROPERTIES =====

        this._scale = 1.0;
    }

    // ===== PROPERTIES =====

    get scale(): number { return this._scale; }
    set scale(scale: number) {
        this._rescale(scale);
    }

    // ===== PUBLIC METHODS =====

    resize(width: number, height: number): void {
        this._prevDrawStyle = "";

        this._fbWidth = width;
        this._fbHeight = height;

        const canvas = this._backbuffer;
        if (canvas.width !== width || canvas.height !== height) {

            // We have to save the canvas data since changing the size will clear it
            let saveImg: ImageData | null = null;
            if (canvas.width > 0 && canvas.height > 0) {
                saveImg = this._drawCtx.getImageData(0, 0, canvas.width, canvas.height);
            }

            if (canvas.width !== width) {
                canvas.width = width;
            }
            if (canvas.height !== height) {
                canvas.height = height;
            }

            if (saveImg) {
                this._drawCtx.putImageData(saveImg, 0, 0);
            }
        }

        // Keep the visible canvas the same size as the framebuffer (the
        // fork has no viewport clipping; the app scales via CSS transform)
        const target = this._target;
        if (target.width !== width || target.height !== height) {
            target.width = width;
            target.height = height;

            this._damage(0, 0, width, height);
            this.flip();

            // Update the visible size of the target canvas
            this._rescale(this._scale);
        }
    }

    // Track what parts of the visible canvas that need updating
    _damage(x: number, y: number, w: number, h: number): void {
        if (x < this._damageBounds.left) {
            this._damageBounds.left = x;
        }
        if (y < this._damageBounds.top) {
            this._damageBounds.top = y;
        }
        if ((x + w) > this._damageBounds.right) {
            this._damageBounds.right = x + w;
        }
        if ((y + h) > this._damageBounds.bottom) {
            this._damageBounds.bottom = y + h;
        }
    }

    // Update the visible canvas with the contents of the
    // rendering canvas
    flip(fromQueue?: boolean): void {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'flip'
            });
        } else {
            let x = this._damageBounds.left;
            let y = this._damageBounds.top;
            let w = this._damageBounds.right - x;
            let h = this._damageBounds.bottom - y;

            if ((x + w) > this._fbWidth) {
                w = this._fbWidth - x;
            }
            if ((y + h) > this._fbHeight) {
                h = this._fbHeight - y;
            }

            if ((w > 0) && (h > 0)) {
                // FIXME: We may need to disable image smoothing here
                //        as well (see copyImage()), but we haven't
                //        noticed any problem yet.
                this._targetCtx.drawImage(this._backbuffer,
                                          x, y, w, h,
                                          x, y, w, h);
            }

            this._damageBounds.left = this._damageBounds.top = 65535;
            this._damageBounds.right = this._damageBounds.bottom = 0;
        }
    }

    pending(): boolean {
        return this._renderQ.length > 0;
    }

    flush(): Promise<void> {
        if (this._renderQ.length === 0) {
            return Promise.resolve();
        } else {
            if (this._flushPromise === null) {
                this._flushPromise = new Promise((resolve) => {
                    this._flushResolve = resolve;
                });
            }
            return this._flushPromise;
        }
    }

    fillRect(x: number, y: number, width: number, height: number, color: number[] | Uint8Array, fromQueue?: boolean): void {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'fill',
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'color': color
            });
        } else {
            this._setFillColor(color);
            this._drawCtx.fillRect(x, y, width, height);
            this._damage(x, y, width, height);
        }
    }

    copyImage(oldX: number, oldY: number, newX: number, newY: number, w: number, h: number, fromQueue?: boolean): void {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'copy',
                'oldX': oldX,
                'oldY': oldY,
                'x': newX,
                'y': newY,
                'width': w,
                'height': h,
            });
        } else {
            // Due to this bug among others [1] we need to disable the image-smoothing to
            // avoid getting a blur effect when copying data.
            //
            // 1. https://bugzilla.mozilla.org/show_bug.cgi?id=1194719
            //
            // We need to set these every time since all properties are reset
            // when the the size is changed
            const legacyCtx = this._drawCtx as CanvasRenderingContext2D & Record<
                "mozImageSmoothingEnabled" | "webkitImageSmoothingEnabled" | "msImageSmoothingEnabled", boolean>;
            legacyCtx.mozImageSmoothingEnabled = false;
            legacyCtx.webkitImageSmoothingEnabled = false;
            legacyCtx.msImageSmoothingEnabled = false;
            this._drawCtx.imageSmoothingEnabled = false;

            this._drawCtx.drawImage(this._backbuffer,
                                    oldX, oldY, w, h,
                                    newX, newY, w, h);
            this._damage(newX, newY, w, h);
        }
    }

    imageRect(x: number, y: number, width: number, height: number, mime: string, arr: Uint8Array): void {
        /* The internal logic cannot handle empty images, so bail early */
        if ((width === 0) || (height === 0)) {
            return;
        }

        // Convert in chunks to avoid blowing the argument limit of
        // String.fromCharCode on large rects
        let binary = "";
        for (let i = 0; i < arr.length; i += 4096) {
            binary += String.fromCharCode(...arr.subarray(i, i + 4096));
        }

        const img = new Image();
        img.src = "data:" + mime + ";base64," + btoa(binary);

        this._renderQPush({
            'type': 'img',
            'img': img,
            'x': x,
            'y': y,
            'width': width,
            'height': height
        });
    }

    blitImage(x: number, y: number, width: number, height: number, arr: Uint8Array, offset: number, fromQueue?: boolean): void {
        if (this._renderQ.length !== 0 && !fromQueue) {
            // NB(directxman12): it's technically more performant here to use preallocated arrays,
            // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
            // this probably isn't getting called *nearly* as much
            const newArr = new Uint8Array(width * height * 4);
            newArr.set(new Uint8Array(arr.buffer, 0, newArr.length));
            this._renderQPush({
                'type': 'blit',
                'data': newArr,
                'x': x,
                'y': y,
                'width': width,
                'height': height,
            });
        } else {
            // NB(directxman12): arr must be an Type Array view
            let data = new Uint8ClampedArray(arr.buffer as ArrayBuffer,
                                             arr.byteOffset + offset,
                                             width * height * 4);
            let img = new ImageData(data, width, height);
            this._drawCtx.putImageData(img, x, y);
            this._damage(x, y, width, height);
        }
    }

    drawImage(img: CanvasImageSource, ...args: number[]): void {
        // The 2D context's drawImage is a set of fixed-arity overloads; the
        // fork only ever forwards a variadic coordinate list, so widen it.
        (this._drawCtx.drawImage as (image: CanvasImageSource, ...coords: number[]) => void)(img, ...args);

        if (args.length <= 4) {
            const [x, y] = args;
            const el = img as HTMLImageElement;
            this._damage(x, y, el.width, el.height);
        } else {
            const [,, sw, sh, dx, dy] = args;
            this._damage(dx, dy, sw, sh);
        }
    }

    // ===== PRIVATE METHODS =====

    _rescale(factor: number): void {
        this._scale = factor;

        // NB(directxman12): If you set the width directly, or set the
        //                   style width to a number, the canvas is cleared.
        //                   However, if you set the style width to a string
        //                   ('NNNpx'), the canvas is scaled without clearing.
        const width = factor * this._fbWidth + 'px';
        const height = factor * this._fbHeight + 'px';

        if ((this._target.style.width !== width) ||
            (this._target.style.height !== height)) {
            this._target.style.width = width;
            this._target.style.height = height;
        }
    }

    _setFillColor(color: number[] | Uint8Array): void {
        const newStyle = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
        if (newStyle !== this._prevDrawStyle) {
            this._drawCtx.fillStyle = newStyle;
            this._prevDrawStyle = newStyle;
        }
    }

    _renderQPush(action: RenderAction): void {
        this._renderQ.push(action);
        if (this._renderQ.length === 1) {
            // If this can be rendered immediately it will be, otherwise
            // the scanner will wait for the relevant event
            this._scanRenderQ();
        }
    }

    _resumeRenderQ(this: HTMLImageElement): void {
        // "this" is the object that is ready, not the
        // display object
        this.removeEventListener('load', this._noVNCDisplay!._resumeRenderQ);
        this._noVNCDisplay!._scanRenderQ();
    }

    _scanRenderQ(): void {
        let ready = true;
        while (ready && this._renderQ.length > 0) {
            const a = this._renderQ[0];
            switch (a.type) {
                case 'flip':
                    this.flip(true);
                    break;
                case 'copy':
                    this.copyImage(a.oldX, a.oldY, a.x, a.y, a.width, a.height, true);
                    break;
                case 'fill':
                    this.fillRect(a.x, a.y, a.width, a.height, a.color, true);
                    break;
                case 'blit':
                    this.blitImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                    break;
                case 'img':
                    if (a.img.complete) {
                        if (a.img.width !== a.width || a.img.height !== a.height) {
                            Log.Error("Decoded image has incorrect dimensions. Got " +
                                      a.img.width + "x" + a.img.height + ". Expected " +
                                      a.width + "x" + a.height + ".");
                            return;
                        }
                        this.drawImage(a.img, a.x, a.y);
                        // This helps the browser free the memory right
                        // away, rather than ballooning
                        a.img.src = "";
                    } else {
                        a.img._noVNCDisplay = this;
                        a.img.addEventListener('load', this._resumeRenderQ);
                        // We need to wait for this image to 'load'
                        // to keep things in-order
                        ready = false;
                    }
                    break;
            }

            if (ready) {
                this._renderQ.shift();
            }
        }

        if (this._renderQ.length === 0 &&
            this._flushPromise !== null) {
            this._flushResolve!();
            this._flushPromise = null;
            this._flushResolve = null;
        }
    }
}
