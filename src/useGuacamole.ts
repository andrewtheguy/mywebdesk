import Guacamole from "guacamole-common-js";
import { useCallback, useEffect, useRef, useState } from "react";

interface Config {
	vncHost: string;
	vncPort: string;
	maxHeight: number;
}

interface ConnectOptions {
	password?: string;
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
const TWO_FINGER_TAP_MAX_MOVE_PX = 12;
const TWO_FINGER_TAP_MAX_DURATION_MS = 260;
const THREE_FINGER_SCROLL_AXIS_LOCK_PX = 10;
const THREE_FINGER_SCROLL_STEP_PX = 32;
const HORIZONTAL_SCROLL_MODIFIER_KEYSYM = 0xffe1;
const RESIZE_RETRY_DELAY_MS = 220;
const MAX_RESIZE_RETRIES = 6;

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

interface DragAssistGesture {
	touchId: number;
	lastClientX: number;
	lastClientY: number;
}

interface TwoFingerTapGesture {
	startTime: number;
	firstId: number;
	secondId: number;
	firstStartX: number;
	firstStartY: number;
	secondStartX: number;
	secondStartY: number;
	valid: boolean;
}

interface ThreeFingerScrollGesture {
	touchIds: [number, number, number];
	startMidX: number;
	startMidY: number;
	lastMidX: number;
	lastMidY: number;
	axis: "x" | "y" | null;
	carryX: number;
	carryY: number;
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

	const connect = useCallback(async (options?: ConnectOptions) => {
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
		let canSendResize = false;

		tunnel.onerror = (status: Guacamole.Status) => {
			if (connectionId !== connectionIdRef.current || manualDisconnectRef.current) return;
			setError(status.message || `Tunnel error code: ${status.code}`);
			setState("error");
		};

		tunnel.onstatechange = (tunnelState: number) => {
			if (connectionId !== connectionIdRef.current) return;
			canSendResize = tunnelState === Guacamole.Tunnel.State.OPEN;
			if (canSendResize) {
				lastRequestedSize = { width: 0, height: 0 };
				doResize();
				if (resizeTimer.current) clearTimeout(resizeTimer.current);
				resizeTimer.current = setTimeout(doResize, 250);
			}
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
		const keyboard = keyboardRef.current || new Guacamole.Keyboard(document);
		keyboardRef.current = keyboard;
		keyboard.onkeydown = (keysym: number) => {
			clientRef.current?.sendKeyEvent(true, keysym);
			return true;
		};
		keyboard.onkeyup = (keysym: number) => {
			clientRef.current?.sendKeyEvent(false, keysym);
		};

		let fitScale = 1;
		let zoomScale = 1;
		let panOffset: PanOffset = { x: 0, y: 0 };
		let pinchGesture: PinchGesture | null = null;
		let mouseGesture: MouseGesture | null = null;
		let dragAssistGesture: DragAssistGesture | null = null;
		let twoFingerTapGesture: TwoFingerTapGesture | null = null;
		let threeFingerScrollGesture: ThreeFingerScrollGesture | null = null;
		let ignoreSingleTouchUntilRelease = false;
		let cursorPosition = { x: 0, y: 0 };
		let hasCursorPosition = false;
		let lastRequestedSize = { width: 0, height: 0 };
		let pendingResizeTarget: { width: number; height: number } | null = null;
		let pendingResizeRetries = 0;
		let resizeRetryTimer: ReturnType<typeof setTimeout> | null = null;

		function clampValue(value: number, min: number, max: number): number {
			return Math.min(max, Math.max(min, value));
		}

		function clearResizeRetryTimer(): void {
			if (resizeRetryTimer) {
				clearTimeout(resizeRetryTimer);
				resizeRetryTimer = null;
			}
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

		function getThreeTouchMidpoint(
			first: Touch,
			second: Touch,
			third: Touch,
		): { x: number; y: number } {
			return {
				x: (first.clientX + second.clientX + third.clientX) / 3,
				y: (first.clientY + second.clientY + third.clientY) / 3,
			};
		}

		function getThreeFingerTouchSet(
			touches: TouchList,
			touchIds: [number, number, number],
		): [Touch, Touch, Touch] | null {
			const first = getTouchById(touches, touchIds[0]);
			const second = getTouchById(touches, touchIds[1]);
			const third = getTouchById(touches, touchIds[2]);
			if (!first || !second || !third) return null;
			return [first, second, third];
		}

		function beginThreeFingerScrollGesture(touches: TouchList): void {
			if (touches.length < 3) return;
			const first = touches[0];
			const second = touches[1];
			const third = touches[2];
			const midpoint = getThreeTouchMidpoint(first, second, third);
			threeFingerScrollGesture = {
				touchIds: [first.identifier, second.identifier, third.identifier],
				startMidX: midpoint.x,
				startMidY: midpoint.y,
				lastMidX: midpoint.x,
				lastMidY: midpoint.y,
				axis: null,
				carryX: 0,
				carryY: 0,
			};
		}

		function beginTwoFingerTapGesture(first: Touch, second: Touch): void {
			twoFingerTapGesture = {
				startTime: Date.now(),
				firstId: first.identifier,
				secondId: second.identifier,
				firstStartX: first.clientX,
				firstStartY: first.clientY,
				secondStartX: second.clientX,
				secondStartY: second.clientY,
				valid: true,
			};
		}

		function updateTwoFingerTapGesture(touches: TouchList): boolean {
			if (!twoFingerTapGesture || !twoFingerTapGesture.valid) return false;
			if (touches.length !== 2) {
				twoFingerTapGesture.valid = false;
				return false;
			}

			const first = getTouchById(touches, twoFingerTapGesture.firstId);
			const second = getTouchById(touches, twoFingerTapGesture.secondId);
			if (!first || !second) {
				twoFingerTapGesture.valid = false;
				return false;
			}

			const firstMoved = Math.hypot(
				first.clientX - twoFingerTapGesture.firstStartX,
				first.clientY - twoFingerTapGesture.firstStartY,
			);
			const secondMoved = Math.hypot(
				second.clientX - twoFingerTapGesture.secondStartX,
				second.clientY - twoFingerTapGesture.secondStartY,
			);
			if (
				firstMoved > TWO_FINGER_TAP_MAX_MOVE_PX ||
				secondMoved > TWO_FINGER_TAP_MAX_MOVE_PX
			) {
				twoFingerTapGesture.valid = false;
				return false;
			}

			return true;
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

		function sendRightClick(): void {
			const cursor = getCurrentCursorPosition();
			client.sendMouseState(
				new Guacamole.Mouse.State(
					cursor.x,
					cursor.y,
					false,
					false,
					true,
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

		function sendWheelFromRemote(
			remoteX: number,
			remoteY: number,
			up: boolean,
			down: boolean,
		): void {
			const clamped = clampCursorToDisplay(remoteX, remoteY);
			cursorPosition = { x: clamped.x, y: clamped.y };
			hasCursorPosition = true;
			client.sendMouseState(
				new Guacamole.Mouse.State(
					clamped.x,
					clamped.y,
					false,
					false,
					false,
					up,
					down,
				),
			);
			client.sendMouseState(
				new Guacamole.Mouse.State(
					clamped.x,
					clamped.y,
					false,
					false,
					false,
					false,
					false,
				),
			);
		}

		function sendVerticalScrollTick(direction: "up" | "down"): void {
			const cursor = getCurrentCursorPosition();
			sendWheelFromRemote(
				cursor.x,
				cursor.y,
				direction === "up",
				direction === "down",
			);
		}

		function sendHorizontalScrollTick(direction: "left" | "right"): void {
			// Guacamole exposes vertical wheel buttons only; emulate horizontal via Shift+Wheel.
			client.sendKeyEvent(true, HORIZONTAL_SCROLL_MODIFIER_KEYSYM);
			sendVerticalScrollTick(direction === "left" ? "up" : "down");
			client.sendKeyEvent(false, HORIZONTAL_SCROLL_MODIFIER_KEYSYM);
		}

		function handleThreeFingerScrollMove(touches: TouchList): boolean {
			if (!threeFingerScrollGesture || touches.length < 3) return false;

			const touchSet = getThreeFingerTouchSet(
				touches,
				threeFingerScrollGesture.touchIds,
			);
			if (!touchSet) {
				threeFingerScrollGesture = null;
				return false;
			}

			const [first, second, third] = touchSet;
			const midpoint = getThreeTouchMidpoint(first, second, third);
			const stepX = midpoint.x - threeFingerScrollGesture.lastMidX;
			const stepY = midpoint.y - threeFingerScrollGesture.lastMidY;
			threeFingerScrollGesture.lastMidX = midpoint.x;
			threeFingerScrollGesture.lastMidY = midpoint.y;

			if (!threeFingerScrollGesture.axis) {
				const totalX = midpoint.x - threeFingerScrollGesture.startMidX;
				const totalY = midpoint.y - threeFingerScrollGesture.startMidY;
				if (
					Math.abs(totalX) < THREE_FINGER_SCROLL_AXIS_LOCK_PX &&
					Math.abs(totalY) < THREE_FINGER_SCROLL_AXIS_LOCK_PX
				) {
					return true;
				}
				threeFingerScrollGesture.axis =
					Math.abs(totalX) >= Math.abs(totalY) ? "x" : "y";
			}

			if (threeFingerScrollGesture.axis === "x") {
				threeFingerScrollGesture.carryX += stepX;
				while (Math.abs(threeFingerScrollGesture.carryX) >= THREE_FINGER_SCROLL_STEP_PX) {
					if (threeFingerScrollGesture.carryX > 0) {
						sendHorizontalScrollTick("right");
						threeFingerScrollGesture.carryX -= THREE_FINGER_SCROLL_STEP_PX;
					} else {
						sendHorizontalScrollTick("left");
						threeFingerScrollGesture.carryX += THREE_FINGER_SCROLL_STEP_PX;
					}
				}
				return true;
			}

			threeFingerScrollGesture.carryY += stepY;
			while (Math.abs(threeFingerScrollGesture.carryY) >= THREE_FINGER_SCROLL_STEP_PX) {
				if (threeFingerScrollGesture.carryY > 0) {
					sendVerticalScrollTick("down");
					threeFingerScrollGesture.carryY -= THREE_FINGER_SCROLL_STEP_PX;
				} else {
					sendVerticalScrollTick("up");
					threeFingerScrollGesture.carryY += THREE_FINGER_SCROLL_STEP_PX;
				}
			}
			return true;
		}

		function moveCursorWithPan(
			stepX: number,
			stepY: number,
			leftDown: boolean,
			baseCursor: { x: number; y: number },
		): void {
			const effectiveScale = Math.max(0.0001, fitScale * zoomScale);
			const desiredCursor = clampCursorToDisplay(
				baseCursor.x + stepX / effectiveScale,
				baseCursor.y + stepY / effectiveScale,
			);

			const visible = getVisibleRemoteBounds(effectiveScale);
			const constrainedCursor = {
				x: clampValue(desiredCursor.x, visible.left, visible.right),
				y: clampValue(desiredCursor.y, visible.top, visible.bottom),
			};
			sendMouseFromRemote(constrainedCursor.x, constrainedCursor.y, leftDown);

			const overflowX = desiredCursor.x - constrainedCursor.x;
			const overflowY = desiredCursor.y - constrainedCursor.y;
			if (overflowX !== 0 || overflowY !== 0) {
				applyDisplayTransform(zoomScale, {
					x: panOffset.x - overflowX * effectiveScale,
					y: panOffset.y - overflowY * effectiveScale,
				});
			}
		}

		function sendDragMoveFromStep(stepX: number, stepY: number): void {
			moveCursorWithPan(stepX, stepY, true, getCurrentCursorPosition());
		}

		function getDragAssistTouch(touches: TouchList): Touch | null {
			if (!mouseGesture || mouseGesture.mode !== "drag") {
				dragAssistGesture = null;
				return null;
			}

			if (dragAssistGesture) {
				const existingTouch = getTouchById(touches, dragAssistGesture.touchId);
				if (existingTouch && existingTouch.identifier !== mouseGesture.touchId) {
					return existingTouch;
				}
				dragAssistGesture = null;
			}

			for (let i = 0; i < touches.length; i += 1) {
				const touch = touches[i];
				if (touch.identifier === mouseGesture.touchId) continue;
				dragAssistGesture = {
					touchId: touch.identifier,
					lastClientX: touch.clientX,
					lastClientY: touch.clientY,
				};
				return touch;
			}

			return null;
		}

		function handleDragAssistMove(touch: Touch): void {
			if (!dragAssistGesture || dragAssistGesture.touchId !== touch.identifier) {
				dragAssistGesture = {
					touchId: touch.identifier,
					lastClientX: touch.clientX,
					lastClientY: touch.clientY,
				};
				return;
			}

			const stepX = touch.clientX - dragAssistGesture.lastClientX;
			const stepY = touch.clientY - dragAssistGesture.lastClientY;
			dragAssistGesture.lastClientX = touch.clientX;
			dragAssistGesture.lastClientY = touch.clientY;

			if (stepX === 0 && stepY === 0) return;
			sendDragMoveFromStep(stepX, stepY);
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
			dragAssistGesture = null;
			threeFingerScrollGesture = null;
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
			dragAssistGesture = null;
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
				const baseCursor = hasCursorPosition
					? cursorPosition
					: {
							x: display.getWidth() / 2,
							y: display.getHeight() / 2,
						};
				moveCursorWithPan(stepX, stepY, false, baseCursor);
				return;
			}

			if (gesture.mode === "drag") return;
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
			if (threeFingerScrollGesture) {
				if (e.touches.length === 3 && handleThreeFingerScrollMove(e.touches)) {
					consumeTouchEvent(e);
					return;
				}
				threeFingerScrollGesture = null;
				if (e.touches.length > 0) {
					ignoreSingleTouchUntilRelease = true;
					twoFingerTapGesture = null;
					pinchGesture = null;
					consumeTouchEvent(e);
					return;
				}
			}

			if (e.touches.length === 3 && mouseGesture?.mode !== "drag") {
				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				dragAssistGesture = null;
				twoFingerTapGesture = null;
				pinchGesture = null;
				beginThreeFingerScrollGesture(e.touches);
				ignoreSingleTouchUntilRelease = true;
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length >= 2) {
				if (mouseGesture?.mode === "drag") {
					ignoreSingleTouchUntilRelease = false;
					twoFingerTapGesture = null;
					pinchGesture = null;
					threeFingerScrollGesture = null;
					const assistTouch = getDragAssistTouch(e.touches);
					if (assistTouch) {
						handleDragAssistMove(assistTouch);
					}
					consumeTouchEvent(e);
					return;
				}

				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				ignoreSingleTouchUntilRelease = true;
				if (e.touches.length === 2) {
					beginTwoFingerTapGesture(e.touches[0], e.touches[1]);
					startPinchGesture(e.touches[0], e.touches[1]);
				} else {
					twoFingerTapGesture = null;
					pinchGesture = null;
				}
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length === 1) {
				twoFingerTapGesture = null;
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
			if (threeFingerScrollGesture) {
				if (e.touches.length === 3 && handleThreeFingerScrollMove(e.touches)) {
					consumeTouchEvent(e);
					return;
				}
				threeFingerScrollGesture = null;
				if (e.touches.length > 0) {
					ignoreSingleTouchUntilRelease = true;
					twoFingerTapGesture = null;
					pinchGesture = null;
					consumeTouchEvent(e);
					return;
				}
			}

			if (e.touches.length === 3 && mouseGesture?.mode !== "drag") {
				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				dragAssistGesture = null;
				twoFingerTapGesture = null;
				pinchGesture = null;
				beginThreeFingerScrollGesture(e.touches);
				ignoreSingleTouchUntilRelease = true;
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length >= 2) {
				if (mouseGesture?.mode === "drag") {
					const primaryTouch = getTouchById(e.touches, mouseGesture.touchId);
					if (!primaryTouch) {
						const releasedPrimary =
							getTouchById(e.changedTouches, mouseGesture.touchId) || null;
						finalizeMouseGesture(releasedPrimary, false);
						twoFingerTapGesture = null;
						pinchGesture = null;
						ignoreSingleTouchUntilRelease = true;
						consumeTouchEvent(e);
						return;
					}

					mouseGesture.lastClientX = primaryTouch.clientX;
					mouseGesture.lastClientY = primaryTouch.clientY;
					const assistTouch = getDragAssistTouch(e.touches);
					if (assistTouch) {
						handleDragAssistMove(assistTouch);
					} else {
						dragAssistGesture = null;
					}
					twoFingerTapGesture = null;
					pinchGesture = null;
					threeFingerScrollGesture = null;
					ignoreSingleTouchUntilRelease = false;
					consumeTouchEvent(e);
					return;
				}

				if (mouseGesture) {
					const activeMouseTouch =
						getTouchById(e.touches, mouseGesture.touchId) || e.touches[0];
					finalizeMouseGesture(activeMouseTouch || null, true);
				}
				ignoreSingleTouchUntilRelease = true;
				if (e.touches.length !== 2) {
					twoFingerTapGesture = null;
				} else {
					const isTwoFingerTapCandidate = updateTwoFingerTapGesture(e.touches);
					if (isTwoFingerTapCandidate) {
						consumeTouchEvent(e);
						return;
					}
					twoFingerTapGesture = null;
				}
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
			if (threeFingerScrollGesture) {
				if (e.touches.length === 3 && handleThreeFingerScrollMove(e.touches)) {
					consumeTouchEvent(e);
					return;
				}
				threeFingerScrollGesture = null;
				dragAssistGesture = null;
				twoFingerTapGesture = null;
				pinchGesture = null;
				if (e.touches.length > 0) {
					ignoreSingleTouchUntilRelease = true;
					consumeTouchEvent(e);
					return;
				}
				ignoreSingleTouchUntilRelease = false;
				consumeTouchEvent(e);
				return;
			}

			if (e.touches.length === 0) {
				if (mouseGesture) {
					const releasedTouch =
						getTouchById(e.changedTouches, mouseGesture.touchId) || null;
					finalizeMouseGesture(releasedTouch, false);
				}
				dragAssistGesture = null;
				threeFingerScrollGesture = null;
				if (twoFingerTapGesture?.valid) {
					const duration = Date.now() - twoFingerTapGesture.startTime;
					if (duration <= TWO_FINGER_TAP_MAX_DURATION_MS) {
						sendRightClick();
					}
				}
				twoFingerTapGesture = null;
				pinchGesture = null;
				ignoreSingleTouchUntilRelease = false;
				consumeTouchEvent(e);
				return;
			}

			if (mouseGesture?.mode === "drag") {
				const primaryTouch = getTouchById(e.touches, mouseGesture.touchId);
				if (!primaryTouch) {
					const releasedTouch =
						getTouchById(e.changedTouches, mouseGesture.touchId) || null;
					finalizeMouseGesture(releasedTouch, false);
					ignoreSingleTouchUntilRelease = true;
				} else {
					mouseGesture.lastClientX = primaryTouch.clientX;
					mouseGesture.lastClientY = primaryTouch.clientY;
					const assistTouch = getDragAssistTouch(e.touches);
					if (assistTouch) {
						dragAssistGesture = {
							touchId: assistTouch.identifier,
							lastClientX: assistTouch.clientX,
							lastClientY: assistTouch.clientY,
						};
					} else {
						dragAssistGesture = null;
					}
					ignoreSingleTouchUntilRelease = false;
				}
				twoFingerTapGesture = null;
				pinchGesture = null;
				threeFingerScrollGesture = null;
				consumeTouchEvent(e);
				return;
			}

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
				if (e.touches.length === 2) {
					updateTwoFingerTapGesture(e.touches);
					startPinchGesture(e.touches[0], e.touches[1]);
				} else {
					twoFingerTapGesture = null;
					pinchGesture = null;
				}
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

			updateTwoFingerTapGesture(e.touches);
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
		displayEl.addEventListener("contextmenu", handleContextMenu);

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
			sendWheelFromRemote(x, y, e.deltaY < 0, e.deltaY > 0);
			e.preventDefault();
		}

		function handleContextMenu(e: MouseEvent) {
			e.preventDefault();
		}

		// Resize to the actual viewport/container size, capped by max-height.
		function doResize() {
			if (!canSendResize) return;

			const vp = window.visualViewport;
			const w = Math.max(1, Math.round(vp ? vp.width : window.innerWidth));
			let h = Math.max(1, Math.round(vp ? vp.height : window.innerHeight));
			const maxHeight = Math.max(1, Number.isFinite(config.maxHeight) ? config.maxHeight : 1);
			if (h > maxHeight) h = maxHeight;

			if (lastRequestedSize.width === w && lastRequestedSize.height === h) {
				return;
			}
			lastRequestedSize = { width: w, height: h };
			pendingResizeTarget = { width: w, height: h };
			pendingResizeRetries = 0;

			// Send CSS-pixel viewport size; multiplying by DPR makes Retina displays look zoomed out.
			client.sendSize(w, h);
			queueResizeRetry();
		}

		function scheduleResize() {
			if (resizeTimer.current) clearTimeout(resizeTimer.current);
			resizeTimer.current = setTimeout(doResize, 250);
		}

		function queueResizeRetry(): void {
			clearResizeRetryTimer();
			if (!pendingResizeTarget || !canSendResize) return;

			resizeRetryTimer = setTimeout(() => {
				if (!pendingResizeTarget || !canSendResize) return;
				const remoteWidth = display.getWidth();
				const remoteHeight = display.getHeight();

				if (
					remoteWidth === pendingResizeTarget.width &&
					remoteHeight === pendingResizeTarget.height
				) {
					pendingResizeTarget = null;
					pendingResizeRetries = 0;
					return;
				}

				if (pendingResizeRetries >= MAX_RESIZE_RETRIES) {
					pendingResizeTarget = null;
					pendingResizeRetries = 0;
					return;
				}

				pendingResizeRetries += 1;
				client.sendSize(pendingResizeTarget.width, pendingResizeTarget.height);
				queueResizeRetry();
			}, RESIZE_RETRY_DELAY_MS);
		}

		// Apply base fit scale and any active pinch zoom/pan.
		display.onresize = () => {
			if (
				pendingResizeTarget &&
				display.getWidth() === pendingResizeTarget.width &&
				display.getHeight() === pendingResizeTarget.height
			) {
				pendingResizeTarget = null;
				pendingResizeRetries = 0;
				clearResizeRetryTimer();
			}
			applyDisplayTransform();
		};

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
		if (options?.password) params.set("PASSWORD", options.password);

		client.connect(params.toString());

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
				displayEl.removeEventListener("contextmenu", handleContextMenu);
				window.removeEventListener("resize", scheduleResize);
				window.removeEventListener("orientationchange", scheduleResize);
				if (window.visualViewport) {
					window.visualViewport.removeEventListener("resize", scheduleResize);
				}
			if (keyboardRef.current) {
				keyboardRef.current.onkeydown = null;
				keyboardRef.current.onkeyup = null;
				keyboardRef.current.reset();
			}
			if (resizeTimer.current) clearTimeout(resizeTimer.current);
			clearResizeRetryTimer();
		};
	}, [containerRef]);

	const disconnect = useCallback(() => {
		manualDisconnectRef.current = true;
		connectionIdRef.current += 1;
		const client = clientRef.current;
		if (!client) {
			if (keyboardRef.current) {
				keyboardRef.current.onkeydown = null;
				keyboardRef.current.onkeyup = null;
				keyboardRef.current.reset();
			}
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
