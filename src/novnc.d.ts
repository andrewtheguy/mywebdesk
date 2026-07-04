// Hand-written type stubs for the vendored noVNC fork (src/vendor/novnc).
// Includes the internal underscore-prefixed surface that HiDpiRFB.ts relies
// on.

declare module "@novnc-core/rfb.js" {
  export interface RFBOptions {
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
  }

  export type NoVncSocket = unknown;

  export default class RFB {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RFBOptions,
    );

    viewOnly: boolean;
    focusOnClick: boolean;
    resizeSession: boolean;
    background: string;

    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;

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

    // ----- Internal API surface of the vendored fork -----
    protected _screen: HTMLDivElement;
    protected _canvas: HTMLCanvasElement;
    protected _display: { scale: number };
    protected _sock: NoVncSocket;
    protected _fbWidth: number;
    protected _fbHeight: number;
    protected _rfbConnectionState:
      | ""
      | "connecting"
      | "connected"
      | "disconnecting"
      | "disconnected";
    protected _screenSize(): { w: number; h: number };
    protected _updateScale(): void;
    protected _updateClip(): void;
    protected _handleResize(): void;
    protected _clientHasExpectedSize(): boolean;
    protected _saveExpectedClientSize(): void;
    protected _requestRemoteResize(): void;
    protected _resize(width: number, height: number): void;

    static messages: {
      pointerEvent(sock: NoVncSocket, x: number, y: number, mask: number): void;
    };
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
