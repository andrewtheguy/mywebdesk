import type { DisplaySize } from "../resizeSizing";

export interface RemoteDesktopEventMap {
  clipboard: { text: string };
  connect: Record<string, never>;
  disconnect: { clean: boolean };
  framebufferResize: DisplaySize;
  securityFailure: { status: number; reason?: string };
}

export type RemoteDesktopEvent = keyof RemoteDesktopEventMap;

export type RemoteDesktopSessionFactory = (
  target: HTMLElement,
  channel: WebSocket,
) => RemoteDesktopSession;

export interface RemoteDesktopSession {
  readonly canvasElement: HTMLCanvasElement;
  readonly connected: boolean;
  readonly framebufferSize: DisplaySize;
  readonly screenElement: HTMLDivElement;

  attachKeyboard(target: Element | Document): () => void;
  disconnect(): void;
  on<K extends RemoteDesktopEvent>(
    event: K,
    listener: (detail: RemoteDesktopEventMap[K]) => void,
  ): () => void;
  requestResize(): void;
  sendClipboard(text: string): void;
  sendKey(keysym: number | null, code: string | null, pressed?: boolean): void;
  sendPointer(x: number, y: number, buttonMask: number): void;
  setDisplayScale(scale: number): void;
  setResizeEnabled(enabled: boolean): void;
  setTargetSizeProvider(provider: (() => DisplaySize) | null): void;
}
