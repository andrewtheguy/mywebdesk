import Guacamole from "guacamole-common-js";
import { useCallback, useEffect, useRef, useState } from "react";

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
const PAN_ACTIVATION_THRESHOLD_PX = 12;
const TAP_THRESHOLD_PX = 12;
const DRAG_LONG_PRESS_MS = 140;

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

interface MouseGesture {
	touchId: number;
	startClientX: number;
	startClientY: number;
	lastClientX: number;
	lastClientY: number;
	mode: "pending" | "pan" | "drag";
	longPressTimer: ReturnType<typeof setTimeout> | null;
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
		let mouseGesture: MouseGesture | null = null;
		let ignoreSingleTouchUntilRelease = false;
		let cursorPosition = { x: 0, y: 0 };
		let hasCursorPosition = false;

		function clampValue(value: number, min: number, max: number): number {
			return Math.min(max, Math.max(min, value));
		}

		function consumeTouchEvent(e: TouchEvent): void {
			e.preventDefault();
			e.stopImmediatePropagation();
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

		function getTouchById(touches: TouchList, touchId: number): Touch | null {
			for (let i = 0; i < touches.length; i += 1) {
				if (touches[i].identifier === touchId) return touches[i];
			}
			return null;
		}

		function clampCursorToDisplay(
			x: number,
			y: number,
		): { x: number; y: number } {
			const width = display.getWidth();
			const height = display.getHeight();
			const maxX = Math.max(0, width - 1);
			const maxY = Math.max(0, height - 1);
			return {
				x: clampValue(Math.round(x), 0, maxX),
				y: clampValue(Math.round(y), 0, maxY),
			};
		}

		function getVisibleRemoteBounds(
			effectiveScale: number,
		): { left: number; right: number; top: number; bottom: number } {
			const displayWidth = display.getWidth();
			const displayHeight = display.getHeight();
			const { width: containerWidth, height: containerHeight } = getContainerSize();
			const maxX = Math.max(0, displayWidth - 1);
			const maxY = Math.max(0, displayHeight - 1);

			const left = clampValue(-panOffset.x / effectiveScale, 0, maxX);
			const top = clampValue(-panOffset.y / effectiveScale, 0, maxY);
			const right = clampValue(left + containerWidth / effectiveScale - 1, left, maxX);
			const bottom = clampValue(top + containerHeight / effectiveScale - 1, top, maxY);

			return { left, right, top, bottom };
		}

		function sendMouseFromRemote(
			remoteX: number,
			remoteY: number,
			leftDown: boolean,
		): void {
			const clamped = clampCursorToDisplay(remoteX, remoteY);
			cursorPosition = { x: clamped.x, y: clamped.y };
			hasCursorPosition = true;
			client.sendMouseState(
				new Guacamole.Mouse.State(
					clamped.x,
					clamped.y,
					leftDown,
					false,
					false,
					false,
					false,
				),
			);
		}

		function sendMouseFromClient(
			clientX: number,
			clientY: number,
			leftDown: boolean,
		): void {
			const rect = displayEl.getBoundingClientRect();
			if (rect.width <= 0) return;
			const scale = display.getWidth() / rect.width;
			const x = Math.round((clientX - rect.left) * scale);
			const y = Math.round((clientY - rect.top) * scale);
			sendMouseFromRemote(x, y, leftDown);
		}

		function getCurrentCursorPosition(): { x: number; y: number } {
			if (hasCursorPosition) return cursorPosition;
			const fallback = clampCursorToDisplay(
				display.getWidth() / 2,
				display.getHeight() / 2,
			);
			cursorPosition = fallback;
			hasCursorPosition = true;
			return fallback;
		}

		function sendTapClick(): void {
			const cursor = getCurrentCursorPosition();
			client.sendMouseState(
				new Guacamole.Mouse.State(
					cursor.x,
					cursor.y,
					true,
					false,
					false,
					false,
					false,
				),
			);
			client.sendMouseState(
				new Guacamole.Mouse.State(
					cursor.x,
					cursor.y,
					false,
					false,
					false,
					false,
					false,
				),
			);
		}

		function sendDragMoveFromStep(stepX: number, stepY: number): void {
			const effectiveScale = Math.max(0.0001, fitScale * zoomScale);
			const baseCursor = getCurrentCursorPosition();
			const nextCursor = clampCursorToDisplay(
				baseCursor.x + stepX / effectiveScale,
				baseCursor.y + stepY / effectiveScale,
			);
			sendMouseFromRemote(nextCursor.x, nextCursor.y, true);
		}

		function clearMouseGestureTimer(gesture: MouseGesture | null): void {
			if (!gesture?.longPressTimer) return;
			clearTimeout(gesture.longPressTimer);
			gesture.longPressTimer = null;
		}

		function beginMouseGesture(touch: Touch): void {
			const gesture: MouseGesture = {
				touchId: touch.identifier,
				startClientX: touch.clientX,
				startClientY: touch.clientY,
				lastClientX: touch.clientX,
				lastClientY: touch.clientY,
				mode: "pending",
				longPressTimer: null,
			};

			gesture.longPressTimer = setTimeout(() => {
				if (!mouseGesture || mouseGesture.touchId !== gesture.touchId) return;
				if (mouseGesture.mode !== "pending") return;
				const moved = Math.hypot(
					mouseGesture.lastClientX - mouseGesture.startClientX,
					mouseGesture.lastClientY - mouseGesture.startClientY,
				);
				if (moved >= PAN_ACTIVATION_THRESHOLD_PX) return;
				mouseGesture.mode = "drag";
				const cursor = getCurrentCursorPosition();
				sendMouseFromRemote(cursor.x, cursor.y, true);
			}, DRAG_LONG_PRESS_MS);

			mouseGesture = gesture;
		}

		function finalizeMouseGesture(touch: Touch | null, suppressTap = false): void {
			if (!mouseGesture) return;

			const gesture = mouseGesture;
			const endX = touch ? touch.clientX : gesture.lastClientX;
			const endY = touch ? touch.clientY : gesture.lastClientY;
			clearMouseGestureTimer(gesture);

			if (gesture.mode === "drag") {
				const cursor = getCurrentCursorPosition();
				sendMouseFromRemote(cursor.x, cursor.y, false);
			} else if (!suppressTap && gesture.mode === "pending") {
				const moved = Math.hypot(
					endX - gesture.startClientX,
					endY - gesture.startClientY,
				);
				if (moved <= TAP_THRESHOLD_PX) {
					sendTapClick();
				}
			}

			mouseGesture = null;
		}

		function handleOneFingerMove(touch: Touch): void {
			if (!mouseGesture) return;

			const gesture = mouseGesture;
			const stepX = touch.clientX - gesture.lastClientX;
			const stepY = touch.clientY - gesture.lastClientY;
			gesture.lastClientX = touch.clientX;
			gesture.lastClientY = touch.clientY;

			const totalDx = touch.clientX - gesture.startClientX;
			const totalDy = touch.clientY - gesture.startClientY;

			if (
				gesture.mode === "pending" &&
				Math.hypot(totalDx, totalDy) >= PAN_ACTIVATION_THRESHOLD_PX
			) {
				clearMouseGestureTimer(gesture);
				gesture.mode = "pan";
			}

			if (gesture.mode === "pan") {
				const effectiveScale = Math.max(0.0001, fitScale * zoomScale);
				const baseCursorX = hasCursorPosition
					? cursorPosition.x
					: display.getWidth() / 2;
				const baseCursorY = hasCursorPosition
					? cursorPosition.y
					: display.getHeight() / 2;
				const desiredCursor = clampCursorToDisplay(
					baseCursorX + stepX / effectiveScale,
					baseCursorY + stepY / effectiveScale,
				);

				const visible = getVisibleRemoteBounds(effectiveScale);
				const constrainedCursor = {
					x: clampValue(desiredCursor.x, visible.left, visible.right),
					y: clampValue(desiredCursor.y, visible.top, visible.bottom),
				};

				sendMouseFromRemote(constrainedCursor.x, constrainedCursor.y, false);

				const overflowX = desiredCursor.x - constrainedCursor.x;
				const overflowY = desiredCursor.y - constrainedCursor.y;
				if (overflowX !== 0 || overflowY !== 0) {
					applyDisplayTransform(zoomScale, {
						x: panOffset.x - overflowX * effectiveScale,
						y: panOffset.y - overflowY * effectiveScale,
					});
				}
				return;
			}

			if (gesture.mode === "drag") {
				sendDragMoveFromStep(stepX, stepY);
			}
		}

		function startPinchGesture(first: Touch, second: Touch): void {
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
		}

		function handleViewportTouchStart(e: TouchEvent) {
			if (e.touches.length >= 2) {
				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				ignoreSingleTouchUntilRelease = true;
				startPinchGesture(e.touches[0], e.touches[1]);
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length === 1) {
				if (ignoreSingleTouchUntilRelease) {
					consumeTouchEvent(e);
					return;
				}
				const touch = e.touches[0];
				pinchGesture = null;
				beginMouseGesture(touch);
				consumeTouchEvent(e);
			}
		}

		function handleViewportTouchMove(e: TouchEvent) {
			if (e.touches.length >= 2) {
				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				ignoreSingleTouchUntilRelease = true;
				const first = e.touches[0];
				const second = e.touches[1];
				if (!pinchGesture) {
					startPinchGesture(first, second);
				} else {
					const distance = getTouchDistance(first, second);
					if (distance > 0) {
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
					}
				}
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length !== 1) return;
			if (ignoreSingleTouchUntilRelease) {
				consumeTouchEvent(e);
				return;
			}

			const activeTouch = mouseGesture
				? getTouchById(e.touches, mouseGesture.touchId) || e.touches[0]
				: e.touches[0];
			if (!mouseGesture) {
				beginMouseGesture(activeTouch);
			}
			handleOneFingerMove(activeTouch);
			consumeTouchEvent(e);
		}

		function handleViewportTouchEnd(e: TouchEvent) {
			if (e.touches.length >= 2) {
				if (mouseGesture) {
					const releasedTouch =
						getTouchById(e.changedTouches, mouseGesture.touchId) ||
						getTouchById(e.touches, mouseGesture.touchId) ||
						e.changedTouches[0] ||
						null;
					finalizeMouseGesture(releasedTouch, true);
				}
				ignoreSingleTouchUntilRelease = true;
				startPinchGesture(e.touches[0], e.touches[1]);
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length === 0) {
				if (mouseGesture) {
					const releasedTouch =
						getTouchById(e.changedTouches, mouseGesture.touchId) || null;
					finalizeMouseGesture(releasedTouch, false);
				}
				pinchGesture = null;
				ignoreSingleTouchUntilRelease = false;
				consumeTouchEvent(e);
				return;
			}

			if (ignoreSingleTouchUntilRelease) {
				consumeTouchEvent(e);
				return;
			}

			if (mouseGesture && !getTouchById(e.touches, mouseGesture.touchId)) {
				const releasedTouch =
					getTouchById(e.changedTouches, mouseGesture.touchId) ||
					e.changedTouches[0] ||
					null;
				finalizeMouseGesture(releasedTouch, false);
			}

			pinchGesture = null;
			consumeTouchEvent(e);
		}

		displayEl.addEventListener("touchstart", handleViewportTouchStart, { passive: false });
		displayEl.addEventListener("touchmove", handleViewportTouchMove, { passive: false });
		displayEl.addEventListener("touchend", handleViewportTouchEnd, { passive: false });
		displayEl.addEventListener("touchcancel", handleViewportTouchEnd, { passive: false });

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
			displayEl.removeEventListener("touchstart", handleViewportTouchStart);
			displayEl.removeEventListener("touchmove", handleViewportTouchMove);
			displayEl.removeEventListener("touchend", handleViewportTouchEnd);
			displayEl.removeEventListener("touchcancel", handleViewportTouchEnd);
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
