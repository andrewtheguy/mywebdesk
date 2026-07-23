import Keyboard from "../../vendor/novnc/core/input/keyboard";
import RFB from "../../vendor/novnc/core/rfb";
import type {
  RemoteDesktopEvent,
  RemoteDesktopEventMap,
  RemoteDesktopSession,
} from "../RemoteDesktopSession";

const RFB_EVENT_NAMES = {
  clipboard: "clipboard",
  connect: "connect",
  cursor: "cursorchange",
  disconnect: "disconnect",
  framebufferResize: "fbresize",
  securityFailure: "securityfailure",
} as const satisfies Record<RemoteDesktopEvent, string>;

export class RfbRemoteDesktopSession implements RemoteDesktopSession {
  readonly #rfb: RFB;

  constructor(target: HTMLElement, channel: WebSocket) {
    this.#rfb = new RFB(target, channel);
  }

  get canvasElement(): HTMLCanvasElement {
    return this.#rfb.canvasElement;
  }

  get connected(): boolean {
    return this.#rfb.connected;
  }

  get framebufferSize() {
    return this.#rfb.fbSize;
  }

  get screenElement(): HTMLDivElement {
    return this.#rfb.screenElement;
  }

  attachKeyboard(target: Element | Document): () => void {
    const keyboard = new Keyboard(target);
    keyboard.onkeyevent = (keysym, code, down) => {
      this.#rfb.sendKey(keysym, code, down);
    };
    keyboard.grab();
    return () => keyboard.ungrab();
  }

  disconnect(): void {
    this.#rfb.disconnect();
  }

  on<K extends RemoteDesktopEvent>(
    event: K,
    listener: (detail: RemoteDesktopEventMap[K]) => void,
  ): () => void {
    const eventName = RFB_EVENT_NAMES[event];
    const eventListener = (rawEvent: Event) => {
      listener((rawEvent as CustomEvent<RemoteDesktopEventMap[K]>).detail);
    };
    this.#rfb.addEventListener(eventName, eventListener);
    return () => this.#rfb.removeEventListener(eventName, eventListener);
  }

  requestResize(): void {
    this.#rfb.requestResize();
  }

  sendClipboard(text: string): void {
    this.#rfb.clipboardPasteFrom(text);
  }

  sendKey(keysym: number | null, code: string | null, pressed?: boolean): void {
    this.#rfb.sendKey(keysym, code, pressed);
  }

  sendPointer(x: number, y: number, buttonMask: number): void {
    this.#rfb.sendPointer(x, y, buttonMask);
  }

  setDisplayScale(scale: number): void {
    this.#rfb.setBaseScale(scale);
  }

  setPictureQuality(level: number): void {
    this.#rfb.qualityLevel = level;
  }

  setResizeEnabled(enabled: boolean): void {
    this.#rfb.resizeSession = enabled;
  }

  setTargetSizeProvider(
    provider: (() => { width: number; height: number }) | null,
  ): void {
    this.#rfb.computeTargetSize = provider;
  }
}

export const createRfbRemoteDesktopSession = (
  target: HTMLElement,
  channel: WebSocket,
): RemoteDesktopSession => new RfbRemoteDesktopSession(target, channel);
