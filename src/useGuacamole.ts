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

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

interface PanOffset {
	x: number;
	y: number;
}

interface PinchGesture {
	initialDistance: number;
	initialZoom: number;
	anchorX: number;
	anchorY: number;
}

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
		displayEl.style.touchAction = "none";
		displayEl.style.transformOrigin = "0 0";
		displayEl.style.willChange = "transform";
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

		let fitScale = 1;
		let zoomScale = 1;
		let panOffset: PanOffset = { x: 0, y: 0 };
		let pinchGesture: PinchGesture | null = null;

		function clampValue(value: number, min: number, max: number): number {
			return Math.min(max, Math.max(min, value));
		}

		function getContainerSize(): { width: number; height: number } {
			return {
				width: Math.max(1, container.clientWidth),
				height: Math.max(1, container.clientHeight),
			};
		}

		function clampPanToBounds(
			x: number,
			y: number,
			effectiveScale: number,
		): PanOffset {
			const { width: containerWidth, height: containerHeight } = getContainerSize();
			const scaledWidth = display.getWidth() * effectiveScale;
			const scaledHeight = display.getHeight() * effectiveScale;
			const minX = Math.min(0, containerWidth - scaledWidth);
			const minY = Math.min(0, containerHeight - scaledHeight);

			return {
				x: clampValue(x, minX, 0),
				y: clampValue(y, minY, 0),
			};
		}

		function applyDisplayTransform(
			nextZoomScale = zoomScale,
			nextPan = panOffset,
		): void {
			const displayWidth = display.getWidth();
			const displayHeight = display.getHeight();
			if (displayWidth <= 0 || displayHeight <= 0) return;

			const { width: containerWidth } = getContainerSize();
			fitScale = Math.min(containerWidth / displayWidth, 1);
			zoomScale = clampValue(nextZoomScale, MIN_ZOOM, MAX_ZOOM);
			const effectiveScale = fitScale * zoomScale;

			display.scale(effectiveScale);
			panOffset = clampPanToBounds(nextPan.x, nextPan.y, effectiveScale);
			displayEl.style.transform = `translate3d(${panOffset.x}px, ${panOffset.y}px, 0)`;
		}

		function getTouchDistance(first: Touch, second: Touch): number {
			return Math.hypot(
				second.clientX - first.clientX,
				second.clientY - first.clientY,
			);
		}

		function getTouchMidpoint(
			first: Touch,
			second: Touch,
		): { x: number; y: number } {
			const rect = container.getBoundingClientRect();
			return {
				x: (first.clientX + second.clientX) / 2 - rect.left,
				y: (first.clientY + second.clientY) / 2 - rect.top,
			};
		}

		function handlePinchStart(e: TouchEvent) {
			if (e.touches.length !== 2) return;

			const first = e.touches[0];
			const second = e.touches[1];
			const initialDistance = getTouchDistance(first, second);
			if (initialDistance <= 0) return;

			const midpoint = getTouchMidpoint(first, second);
			const effectiveScale = Math.max(0.0001, fitScale * zoomScale);

			pinchGesture = {
				initialDistance,
				initialZoom: zoomScale,
				anchorX: (midpoint.x - panOffset.x) / effectiveScale,
				anchorY: (midpoint.y - panOffset.y) / effectiveScale,
			};
			e.preventDefault();
		}

		function handlePinchMove(e: TouchEvent) {
			if (e.touches.length !== 2 || !pinchGesture) return;

			const first = e.touches[0];
			const second = e.touches[1];
			const distance = getTouchDistance(first, second);
			if (distance <= 0) return;

			const midpoint = getTouchMidpoint(first, second);
			const nextZoom = clampValue(
				pinchGesture.initialZoom * (distance / pinchGesture.initialDistance),
				MIN_ZOOM,
				MAX_ZOOM,
			);
			const effectiveScale = fitScale * nextZoom;
			const nextPan: PanOffset = {
				x: midpoint.x - pinchGesture.anchorX * effectiveScale,
				y: midpoint.y - pinchGesture.anchorY * effectiveScale,
			};

			applyDisplayTransform(nextZoom, nextPan);
			e.preventDefault();
		}

		function handlePinchEnd(e: TouchEvent) {
			if (e.touches.length === 2) {
				handlePinchStart(e);
				return;
			}
			pinchGesture = null;
		}

		displayEl.addEventListener("touchstart", handlePinchStart, { passive: false });
		displayEl.addEventListener("touchmove", handlePinchMove, { passive: false });
		displayEl.addEventListener("touchend", handlePinchEnd, { passive: false });
		displayEl.addEventListener("touchcancel", handlePinchEnd, { passive: false });

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

		// Resize using VNC framebuffer dimensions as the minimum, with max-height cap.
		function doResize() {
			const vp = window.visualViewport;
			let w = Math.round(vp ? vp.width : window.innerWidth);
			let h = Math.round(vp ? vp.height : window.innerHeight);

			const remoteWidth = display.getWidth();
			const remoteHeight = display.getHeight();
			const minWidth = Math.max(1, remoteWidth > 0 ? remoteWidth : 1);
			const maxHeight = Math.max(1, Number.isFinite(config.maxHeight) ? config.maxHeight : 1);
			const minHeight = Math.max(
				1,
				Math.min(maxHeight, remoteHeight > 0 ? remoteHeight : 1),
			);

			w = Math.max(w, minWidth);
			if (h > maxHeight) h = maxHeight;
			h = Math.max(h, minHeight);
			// Send CSS-pixel viewport size; multiplying by DPR makes Retina displays look zoomed out.
			client.sendSize(w, h);
			applyDisplayTransform();
		}

		function scheduleResize() {
			applyDisplayTransform();
			if (resizeTimer.current) clearTimeout(resizeTimer.current);
			resizeTimer.current = setTimeout(doResize, 300);
		}

		function handleInitialResize() {
			doResize();
			scheduleResize();
		}

		// Apply base fit scale and any active pinch zoom/pan.
		display.onresize = () => {
			applyDisplayTransform();
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
			displayEl.removeEventListener("touchstart", handlePinchStart);
			displayEl.removeEventListener("touchmove", handlePinchMove);
			displayEl.removeEventListener("touchend", handlePinchEnd);
			displayEl.removeEventListener("touchcancel", handlePinchEnd);
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
