import Guacamole from "guacamole-common-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachTouchHandler } from "./touchHandler";

interface Config {
	vncHost: string;
	vncPort: string;
	vncPassword: string;
	maxHeight: number;
}

export type ConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

export function useGuacamole(containerRef: React.RefObject<HTMLDivElement | null>) {
	const clientRef = useRef<Guacamole.Client | null>(null);
	const keyboardRef = useRef<Guacamole.Keyboard | null>(null);
	const connectionIdRef = useRef(0);
	const manualDisconnectRef = useRef(false);
	const [state, setState] = useState<ConnectionState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [clipboardText, setClipboardText] = useState("");
	const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const connect = useCallback(async () => {
		const container = containerRef.current;
		if (!container) return;
		const connectionId = connectionIdRef.current + 1;
		connectionIdRef.current = connectionId;
		manualDisconnectRef.current = false;

		setState("connecting");
		setError(null);

		// Fetch config from server
		let config: Config;
		try {
			const res = await fetch("/api/config");
			config = await res.json();
		} catch {
			if (connectionId !== connectionIdRef.current) return;
			setError("Failed to fetch config");
			setState("error");
			return;
		}
		if (connectionId !== connectionIdRef.current) return;

		const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${wsProtocol}//${window.location.host}/guac/ws`;
		const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
		const client = new Guacamole.Client(tunnel);
		clientRef.current = client;

		tunnel.onerror = (status: Guacamole.Status) => {
			if (connectionId !== connectionIdRef.current || manualDisconnectRef.current) return;
			setError(status.message || `Tunnel error code: ${status.code}`);
			setState("error");
		};

		tunnel.onstatechange = (tunnelState: number) => {
			if (connectionId !== connectionIdRef.current) return;
			if (tunnelState === Guacamole.Tunnel.State.CLOSED) {
				if (manualDisconnectRef.current) {
					setState("disconnected");
				} else {
					setError((prev) => prev || "Tunnel closed unexpectedly");
					setState("error");
				}
			}
		};

		// Add display element
		const display = client.getDisplay();
		const displayEl = display.getElement();
		displayEl.style.cursor = "none";
		container.appendChild(displayEl);

		// State change handler
		client.onstatechange = (clientState: number) => {
			if (connectionId !== connectionIdRef.current) return;
			switch (clientState) {
				case Guacamole.Client.State.CONNECTING:
				case Guacamole.Client.State.WAITING:
					setState("connecting");
					break;
				case Guacamole.Client.State.CONNECTED:
					setState("connected");
					break;
				case Guacamole.Client.State.DISCONNECTED:
				case Guacamole.Client.State.DISCONNECTING:
					setState("disconnected");
					break;
			}
		};

		client.onerror = (status: Guacamole.Status) => {
			if (connectionId !== connectionIdRef.current) return;
			setError(status.message || `Error code: ${status.code}`);
			setState("error");
		};

		// Clipboard from remote
		client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
			if (mimetype !== "text/plain") return;
			const reader = new Guacamole.StringReader(stream);
			let data = "";
			reader.ontext = (text: string) => {
				data += text;
			};
			reader.onend = () => {
				setClipboardText(data);
			};
		};

		// Keyboard
		const keyboard = new Guacamole.Keyboard(document);
		keyboardRef.current = keyboard;
		keyboard.onkeydown = (keysym: number) => {
			client.sendKeyEvent(true, keysym);
			return true;
		};
		keyboard.onkeyup = (keysym: number) => {
			client.sendKeyEvent(false, keysym);
		};

		// Mouse (desktop)
		displayEl.addEventListener("mousedown", handleMouse);
		displayEl.addEventListener("mouseup", handleMouse);
		displayEl.addEventListener("mousemove", handleMouse);
		displayEl.addEventListener("wheel", handleWheel, { passive: false });
		displayEl.addEventListener("contextmenu", (e) => e.preventDefault());

		function handleMouse(e: MouseEvent) {
			const rect = displayEl.getBoundingClientRect();
			const scale = display.getWidth() / rect.width;
			const x = Math.round((e.clientX - rect.left) * scale);
			const y = Math.round((e.clientY - rect.top) * scale);
			const mouseState = new Guacamole.Mouse.State(
				x,
				y,
				!!(e.buttons & 1),
				!!(e.buttons & 4),
				!!(e.buttons & 2),
				false,
				false,
			);
			client.sendMouseState(mouseState);
			e.preventDefault();
		}

		function handleWheel(e: WheelEvent) {
			const rect = displayEl.getBoundingClientRect();
			const scale = display.getWidth() / rect.width;
			const x = Math.round((e.clientX - rect.left) * scale);
			const y = Math.round((e.clientY - rect.top) * scale);
			client.sendMouseState(
				new Guacamole.Mouse.State(
					x,
					y,
					false,
					false,
					false,
					e.deltaY < 0,
					e.deltaY > 0,
				),
			);
			// Release scroll buttons
			client.sendMouseState(
				new Guacamole.Mouse.State(x, y, false, false, false, false, false),
			);
			e.preventDefault();
		}

		// Touch handler (mobile)
		const detachTouch = attachTouchHandler(
			displayEl,
			(mouseState) => {
				// Scale touch coords to display coords
				const rect = displayEl.getBoundingClientRect();
				const scale = display.getWidth() / rect.width;
				const scaled = new Guacamole.Mouse.State(
					Math.round(mouseState.x * scale),
					Math.round(mouseState.y * scale),
					mouseState.left,
					mouseState.middle,
					mouseState.right,
					mouseState.up,
					mouseState.down,
				);
				client.sendMouseState(scaled);
			},
			Guacamole.Mouse.State,
		);

		// Resize with max-height cap
		function doResize() {
			const vp = window.visualViewport;
			const w = Math.max(1, Math.round(vp ? vp.width : window.innerWidth));
			let h = Math.round(vp ? vp.height : window.innerHeight);
			if (h > config.maxHeight) h = config.maxHeight;
			h = Math.max(1, h);
			// Send CSS-pixel viewport size; multiplying by DPR makes Retina displays look zoomed out.
			client.sendSize(w, h);
		}

		function scheduleResize() {
			if (resizeTimer.current) clearTimeout(resizeTimer.current);
			resizeTimer.current = setTimeout(doResize, 300);
		}

		function handleInitialResize() {
			doResize();
			scheduleResize();
		}

		// Scale display to fit container
		display.onresize = () => {
			const displayWidth = display.getWidth();
			if (displayWidth <= 0) return;
			const containerWidth = container.offsetWidth;
			const scale = containerWidth / displayWidth;
			display.scale(Math.min(scale, 1));
		};

		window.addEventListener("load", handleInitialResize);
		window.addEventListener("resize", scheduleResize);
		window.addEventListener("orientationchange", scheduleResize);
		if (window.visualViewport) {
			window.visualViewport.addEventListener("resize", scheduleResize);
		}

		// Build connection string
		const params = new URLSearchParams();
		params.set("VERSION", "VERSION_1_5_0");
		params.set("TYPE", "vnc");
		params.set("HOSTNAME", config.vncHost);
		params.set("PORT", config.vncPort);
		if (config.vncPassword) params.set("PASSWORD", config.vncPassword);

		client.connect(params.toString());
		handleInitialResize();

		// Store cleanup in ref for disconnect
		(client as unknown as Record<string, unknown>).__cleanup = () => {
			tunnel.onerror = null;
			tunnel.onstatechange = null;
			detachTouch();
			displayEl.removeEventListener("mousedown", handleMouse);
			displayEl.removeEventListener("mouseup", handleMouse);
			displayEl.removeEventListener("mousemove", handleMouse);
			displayEl.removeEventListener("wheel", handleWheel);
			window.removeEventListener("load", handleInitialResize);
			window.removeEventListener("resize", scheduleResize);
			window.removeEventListener("orientationchange", scheduleResize);
			if (window.visualViewport) {
				window.visualViewport.removeEventListener("resize", scheduleResize);
			}
			if (keyboardRef.current) {
				keyboardRef.current.reset();
				keyboardRef.current = null;
			}
			if (resizeTimer.current) clearTimeout(resizeTimer.current);
		};
	}, [containerRef]);

	const disconnect = useCallback(() => {
		manualDisconnectRef.current = true;
		connectionIdRef.current += 1;
		const client = clientRef.current;
		if (!client) {
			setState("disconnected");
			return;
		}
		const cleanup = (client as unknown as Record<string, unknown>).__cleanup as (() => void) | undefined;
		cleanup?.();
		client.disconnect();
		clientRef.current = null;
		setState("disconnected");

		// Remove display element
		const container = containerRef.current;
		if (container) {
			while (container.firstChild) container.removeChild(container.firstChild);
		}
	}, [containerRef]);

	const sendClipboard = useCallback((text: string) => {
		const client = clientRef.current;
		if (!client) return;
		const stream = client.createClipboardStream("text/plain");
		const writer = new Guacamole.StringWriter(stream);
		writer.sendText(text);
		writer.sendEnd();
	}, []);

	const sendKey = useCallback((keysym: number, pressed: boolean) => {
		clientRef.current?.sendKeyEvent(pressed, keysym);
	}, []);

	const sendCtrlAltDel = useCallback(() => {
		const client = clientRef.current;
		if (!client) return;
		client.sendKeyEvent(true, 0xffe3); // Ctrl
		client.sendKeyEvent(true, 0xffe9); // Alt
		client.sendKeyEvent(true, 0xffff); // Delete
		client.sendKeyEvent(false, 0xffff);
		client.sendKeyEvent(false, 0xffe9);
		client.sendKeyEvent(false, 0xffe3);
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			disconnect();
		};
	}, [disconnect]);

	return {
		connect,
		disconnect,
		sendClipboard,
		sendKey,
		sendCtrlAltDel,
		state,
		error,
		clipboardText,
	};
}
