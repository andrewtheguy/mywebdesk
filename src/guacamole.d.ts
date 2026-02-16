declare module "guacamole-common-js" {
	namespace Guacamole {
		class Client {
			constructor(tunnel: Tunnel);
			connect(data?: string): void;
			disconnect(): void;
			sendSize(width: number, height: number): void;
			sendMouseState(state: Mouse.State): void;
			sendKeyEvent(pressed: boolean, keysym: number): void;
			getDisplay(): Display;
			createClipboardStream(mimetype: string): OutputStream;
			onclipboard: ((stream: InputStream, mimetype: string) => void) | null;
			onstatechange: ((state: number) => void) | null;
			onerror: ((status: Status) => void) | null;

			static readonly State: {
				readonly IDLE: 0;
				readonly CONNECTING: 1;
				readonly WAITING: 2;
				readonly CONNECTED: 3;
				readonly DISCONNECTING: 4;
				readonly DISCONNECTED: 5;
			};
		}

		class Tunnel {
			onerror: ((status: Status) => void) | null;
			onstatechange: ((state: number) => void) | null;

			static readonly State: {
				readonly CONNECTING: 0;
				readonly OPEN: 1;
				readonly CLOSED: 2;
				readonly UNSTABLE: 3;
			};
		}

		class WebSocketTunnel extends Tunnel {
			constructor(url: string);
		}

		class Display {
			getElement(): HTMLElement;
			getDefaultLayer(): Display.VisibleLayer;
			scale(scale: number): void;
			getWidth(): number;
			getHeight(): number;
			onresize: ((width: number, height: number) => void) | null;
		}

		namespace Display {
			class VisibleLayer {
				width: number;
				height: number;
			}
		}

		namespace Mouse {
			class State {
				x: number;
				y: number;
				left: boolean;
				middle: boolean;
				right: boolean;
				up: boolean;
				down: boolean;
				constructor(
					x: number,
					y: number,
					left: boolean,
					middle: boolean,
					right: boolean,
					up: boolean,
					down: boolean,
				);
			}
		}

		class Keyboard {
			constructor(element: HTMLElement | Document);
			onkeydown: ((keysym: number) => boolean | undefined) | null;
			onkeyup: ((keysym: number) => void) | null;
			reset(): void;
		}

		class InputStream {
			onblob: ((data: string) => void) | null;
			onend: (() => void) | null;
		}

		class OutputStream {
			sendBlob(data: string): void;
			sendEnd(): void;
		}

		class StringReader {
			constructor(stream: InputStream);
			ontext: ((text: string) => void) | null;
			onend: (() => void) | null;
		}

		class StringWriter {
			constructor(stream: OutputStream);
			sendText(text: string): void;
			sendEnd(): void;
		}

		class Status {
			code: number;
			message?: string;
			isError(): boolean;
		}
	}

	export = Guacamole;
}
