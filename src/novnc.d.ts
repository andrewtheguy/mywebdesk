// Hand-written type declarations for the vendored noVNC fork
// (src/vendor/novnc, reached via the @novnc-core vite alias). Only the
// fork's public surface is declared; keep this in sync with core/rfb.js.

declare module "@novnc-core/rfb.js" {
  export interface FbSize {
    width: number;
    height: number;
  }

  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
    fbresize: CustomEvent<FbSize>;
  }

  export default class RFB {
    constructor(target: HTMLElement, channel: WebSocket);

    viewOnly: boolean;
    focusOnClick: boolean;
    resizeSession: boolean;

    // When set, returns the desired framebuffer size in device pixels and
    // becomes the sole source for setDesktopSize requests.
    computeTargetSize: (() => FbSize) | null;

    readonly connected: boolean;
    readonly fbSize: FbSize;
    readonly canvasElement: HTMLCanvasElement;
    readonly screenElement: HTMLDivElement;

    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
    setBaseScale(scale: number): void;
    requestResize(): void;
    sendPointer(x: number, y: number, buttonMask: number): void;

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
    ): void;
    addEventListener(type: string, listener: (ev: Event) => void): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
    ): void;
    removeEventListener(type: string, listener: (ev: Event) => void): void;
    dispatchEvent(event: Event): boolean;
  }
}

declare module "@novnc-core/input/keyboard.js" {
  export default class Keyboard {
    constructor(target: Element | Document);
    onkeyevent: (
      keysym: number,
      code: string,
      down: boolean,
      numlock?: boolean | null,
      capslock?: boolean | null,
    ) => void;
    grab(): void;
    ungrab(): void;
  }
}
