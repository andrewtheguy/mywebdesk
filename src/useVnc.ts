import Keyboard from "@novnc-core/input/keyboard.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseConnectionConfig } from "./connectionConfig";
import { HiDpiRFB } from "./HiDpiRFB";
import { computeResizeTarget } from "./resizeSizing";
import { type MouseButtonState, toRfbButtonMask } from "./rfbInput";

interface ConnectOptions {
  sessionId?: string;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const TAP_MAX_MOVE_PX = 4;
const TAP_MAX_DURATION_MS = 200;
const PAN_ACTIVATION_THRESHOLD_PX = 12;
const PAN_CURSOR_SPEED = 1.5;
const FORCE_TAP_THRESHOLD = 0.15;
const DOUBLE_TAP_WINDOW_MS = 300;
const TWO_FINGER_TAP_MAX_MOVE_PX = 12;
const TWO_FINGER_TAP_MAX_DURATION_MS = 260;
const THREE_FINGER_SCROLL_AXIS_LOCK_PX = 10;
const THREE_FINGER_SCROLL_STEP_PX = 32;
const RESIZE_RETRY_DELAY_MS = 220;
const MAX_RESIZE_RETRIES = 6;

// RFB pointer button masks (buttons 6/7 = horizontal wheel).
const MASK_NONE = 0;
const MASK_WHEEL_LEFT = 32;
const MASK_WHEEL_RIGHT = 64;

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
  maxForce: number;
  startTime: number;
  mode: "pending" | "pan" | "drag";
  moved: boolean;
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

export function useVnc(containerRef: React.RefObject<HTMLDivElement | null>) {
  const rfbRef = useRef<HiDpiRFB | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const keyboardTargetRef = useRef<HTMLElement | Document | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectionIdRef = useRef(0);
  const manualDisconnectRef = useRef(false);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(
    async (options?: ConnectOptions) => {
      const container = containerRef.current;
      if (!container) return;
      const containerEl = container;
      const connectionId = connectionIdRef.current + 1;
      connectionIdRef.current = connectionId;
      manualDisconnectRef.current = false;

      // Tear down any previous connection's DOM/listeners first.
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // Already torn down.
        }
        rfbRef.current = null;
      }

      setState("connecting");
      setError(null);

      // Pre-flight: verify auth and config shape before opening the tunnel.
      // The proxy holds the VNC target and password server-side.
      try {
        const res = await fetch("/api/app/config");
        if (!res.ok) {
          const responseBody = (await res.text()).trim();
          if (connectionId !== connectionIdRef.current) return;
          setError(
            responseBody
              ? `Failed to fetch config (${res.status}): ${responseBody}`
              : `Failed to fetch config (${res.status})`,
          );
          setState("error");
          return;
        }
        parseConnectionConfig(await res.json());
      } catch (err) {
        if (connectionId !== connectionIdRef.current) return;
        setError(
          err instanceof Error && err.message.startsWith("Invalid config")
            ? err.message
            : "Failed to fetch config",
        );
        setState("error");
        return;
      }
      if (connectionId !== connectionIdRef.current) return;

      const canPinchZoom = (navigator.maxTouchPoints || 0) >= 2;
      const useHiDpiSessionSizing = !canPinchZoom;

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsParams = new URLSearchParams();
      if (options?.sessionId) wsParams.set("SESSION_ID", options.sessionId);
      const wsUrl = `${wsProtocol}//${window.location.host}/vnc/ws?${wsParams.toString()}`;

      // Build the WebSocket ourselves so we can observe the close code
      // (4001 = evicted by a session takeover) before handing it to RFB.
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("close", (event) => {
        if (
          connectionId !== connectionIdRef.current ||
          manualDisconnectRef.current
        )
          return;
        if (event.code === 4001) {
          setError("Session taken over by another client");
        } else if (event.reason === "vnc-unreachable") {
          setError("Unable to reach the configured VNC target");
        } else if (event.reason === "vnc-handshake-failed") {
          setError(
            "VNC handshake failed on the server (check VNC_PASSWORD and the server log)",
          );
        }
      });

      // Mount point for noVNC's screen/canvas plus our input overlay on top.
      // The overlay starves noVNC's own canvas-attached mouse/touch handlers
      // (viewOnly must stay false or noVNC refuses resize/key requests).
      containerEl.style.position = "relative";
      const overlayEl = document.createElement("div");
      overlayEl.style.position = "absolute";
      overlayEl.style.inset = "0";
      overlayEl.style.zIndex = "1";
      overlayEl.style.cursor = "none";
      overlayEl.style.touchAction = "none";

      // No credentials: the server-side proxy answers the VNC auth challenge
      // itself and presents security type None to the browser, so the VNC
      // password never reaches the client.
      const rfb = new HiDpiRFB(containerEl, ws);
      rfbRef.current = rfb;
      rfb.focusOnClick = false;
      containerEl.appendChild(overlayEl);

      const screenEl = rfb.screenElement;
      const canvasEl = rfb.canvasElement;
      screenEl.style.overflow = "hidden";
      canvasEl.style.margin = "0";
      canvasEl.style.transformOrigin = "0 0";
      canvasEl.style.willChange = "transform";

      let canSendResize = false;

      function getRemoteWidth(): number {
        return rfb.fbSize.width;
      }

      function getRemoteHeight(): number {
        return rfb.fbSize.height;
      }

      function sendMouse(x: number, y: number, state: MouseButtonState): void {
        rfb.sendPointer(x, y, toRfbButtonMask(state));
      }

      let fitScale = 1;
      let zoomScale = 1;
      let panOffset: PanOffset = { x: 0, y: 0 };
      let pinchGesture: PinchGesture | null = null;
      let mouseGesture: MouseGesture | null = null;
      let dragAssistGesture: DragAssistGesture | null = null;
      let twoFingerTapGesture: TwoFingerTapGesture | null = null;
      let threeFingerScrollGesture: ThreeFingerScrollGesture | null = null;
      let ignoreSingleTouchUntilRelease = false;
      let lastTapTime = 0;
      let pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
      let cursorPosition = { x: 0, y: 0 };
      let hasCursorPosition = false;
      let touchMinimumSize: { width: number; height: number } | null = null;
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
          width: Math.max(1, containerEl.clientWidth),
          height: Math.max(1, containerEl.clientHeight),
        };
      }

      function computeSessionSizeTarget(): { width: number; height: number } {
        const vp = window.visualViewport;
        const dpr = useHiDpiSessionSizing ? window.devicePixelRatio || 1 : 1;
        return computeResizeTarget({
          viewportWidth: vp ? vp.width : window.innerWidth,
          viewportHeight: vp ? vp.height : window.innerHeight,
          dpr,
          // Touch devices keep the session at least at the geometry found on
          // connect so pinch-zoom has full resolution; desktop follows the
          // viewport exactly in both directions.
          minimumSize: useHiDpiSessionSizing ? null : touchMinimumSize,
        });
      }

      // noVNC reads this whenever it decides to request a remote resize
      // (our doResize pokes, plus its own container ResizeObserver).
      rfb.computeTargetSize = () => computeSessionSizeTarget();
      rfb.resizeSession = true;

      function clampPanToBounds(
        x: number,
        y: number,
        effectiveScale: number,
      ): PanOffset {
        const { width: containerWidth, height: containerHeight } =
          getContainerSize();
        const scaledWidth = getRemoteWidth() * effectiveScale;
        const scaledHeight = getRemoteHeight() * effectiveScale;
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
        const displayWidth = getRemoteWidth();
        const displayHeight = getRemoteHeight();
        if (displayWidth <= 0 || displayHeight <= 0) return;

        const { width: containerWidth } = getContainerSize();
        fitScale = Math.min(containerWidth / displayWidth, 1);
        zoomScale = clampValue(nextZoomScale, MIN_ZOOM, MAX_ZOOM);
        const effectiveScale = fitScale * zoomScale;

        rfb.setBaseScale(effectiveScale);
        panOffset = clampPanToBounds(nextPan.x, nextPan.y, effectiveScale);
        canvasEl.style.transform = `translate3d(${panOffset.x}px, ${panOffset.y}px, 0)`;
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
        const rect = containerEl.getBoundingClientRect();
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
        const width = getRemoteWidth();
        const height = getRemoteHeight();
        const maxX = Math.max(0, width - 1);
        const maxY = Math.max(0, height - 1);
        return {
          x: clampValue(Math.round(x), 0, maxX),
          y: clampValue(Math.round(y), 0, maxY),
        };
      }

      function getVisibleRemoteBounds(effectiveScale: number): {
        left: number;
        right: number;
        top: number;
        bottom: number;
      } {
        const displayWidth = getRemoteWidth();
        const displayHeight = getRemoteHeight();
        const { width: containerWidth, height: containerHeight } =
          getContainerSize();
        const maxX = Math.max(0, displayWidth - 1);
        const maxY = Math.max(0, displayHeight - 1);

        const left = clampValue(-panOffset.x / effectiveScale, 0, maxX);
        const top = clampValue(-panOffset.y / effectiveScale, 0, maxY);
        const right = clampValue(
          left + containerWidth / effectiveScale - 1,
          left,
          maxX,
        );
        const bottom = clampValue(
          top + containerHeight / effectiveScale - 1,
          top,
          maxY,
        );

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
        sendMouse(clamped.x, clamped.y, { left: leftDown });
      }

      function getCurrentCursorPosition(): { x: number; y: number } {
        if (hasCursorPosition) return cursorPosition;
        const fallback = clampCursorToDisplay(
          getRemoteWidth() / 2,
          getRemoteHeight() / 2,
        );
        cursorPosition = fallback;
        hasCursorPosition = true;
        return fallback;
      }

      function sendTapClick(): void {
        const cursor = getCurrentCursorPosition();
        sendMouse(cursor.x, cursor.y, { left: true });
        sendMouse(cursor.x, cursor.y, {});
      }

      function sendRightClick(): void {
        const cursor = getCurrentCursorPosition();
        sendMouse(cursor.x, cursor.y, { right: true });
        sendMouse(cursor.x, cursor.y, {});
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
        sendMouse(clamped.x, clamped.y, { up, down });
        sendMouse(clamped.x, clamped.y, {});
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
        // RFB has native horizontal wheel buttons (6/7), so send them directly.
        const cursor = getCurrentCursorPosition();
        rfb.sendPointer(
          cursor.x,
          cursor.y,
          direction === "left" ? MASK_WHEEL_LEFT : MASK_WHEEL_RIGHT,
        );
        rfb.sendPointer(cursor.x, cursor.y, MASK_NONE);
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
          while (
            Math.abs(threeFingerScrollGesture.carryX) >=
            THREE_FINGER_SCROLL_STEP_PX
          ) {
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
        while (
          Math.abs(threeFingerScrollGesture.carryY) >=
          THREE_FINGER_SCROLL_STEP_PX
        ) {
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
        const speed = leftDown ? 1 : PAN_CURSOR_SPEED;
        const desiredCursor = clampCursorToDisplay(
          baseCursor.x + (stepX * speed) / effectiveScale,
          baseCursor.y + (stepY * speed) / effectiveScale,
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
          const existingTouch = getTouchById(
            touches,
            dragAssistGesture.touchId,
          );
          if (
            existingTouch &&
            existingTouch.identifier !== mouseGesture.touchId
          ) {
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
        if (
          !dragAssistGesture ||
          dragAssistGesture.touchId !== touch.identifier
        ) {
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

      function cancelPendingTap(): void {
        if (pendingTapTimer !== null) {
          clearTimeout(pendingTapTimer);
          pendingTapTimer = null;
        }
      }

      function beginMouseGesture(touch: Touch): void {
        const now = Date.now();
        const isSecondTap = now - lastTapTime <= DOUBLE_TAP_WINDOW_MS;

        const gesture: MouseGesture = {
          touchId: touch.identifier,
          startClientX: touch.clientX,
          startClientY: touch.clientY,
          lastClientX: touch.clientX,
          lastClientY: touch.clientY,
          maxForce: touch.force ?? 0,
          startTime: now,
          mode: isSecondTap ? "drag" : "pending",
          moved: false,
        };

        if (isSecondTap) {
          cancelPendingTap();
          lastTapTime = 0;
          const cursor = getCurrentCursorPosition();
          sendMouseFromRemote(cursor.x, cursor.y, true);
        }

        mouseGesture = gesture;
        dragAssistGesture = null;
        threeFingerScrollGesture = null;
      }

      function finalizeMouseGesture(
        touch: Touch | null,
        suppressTap = false,
      ): void {
        if (!mouseGesture) return;

        const gesture = mouseGesture;
        if (touch) {
          gesture.maxForce = Math.max(gesture.maxForce, touch.force ?? 0);
        }
        if (gesture.mode === "drag") {
          const cursor = getCurrentCursorPosition();
          sendMouseFromRemote(cursor.x, cursor.y, false);
          const duration = Date.now() - gesture.startTime;
          if (
            !gesture.moved &&
            duration <= TAP_MAX_DURATION_MS &&
            gesture.maxForce >= FORCE_TAP_THRESHOLD
          ) {
            sendTapClick();
          }
        } else if (!suppressTap && gesture.mode === "pending") {
          const duration = Date.now() - gesture.startTime;
          if (
            !gesture.moved &&
            duration <= TAP_MAX_DURATION_MS &&
            gesture.maxForce >= FORCE_TAP_THRESHOLD
          ) {
            lastTapTime = Date.now();
            cancelPendingTap();
            pendingTapTimer = setTimeout(() => {
              pendingTapTimer = null;
              sendTapClick();
            }, DOUBLE_TAP_WINDOW_MS);
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
        gesture.maxForce = Math.max(gesture.maxForce, touch.force ?? 0);

        const totalDx = touch.clientX - gesture.startClientX;
        const totalDy = touch.clientY - gesture.startClientY;

        if (!gesture.moved && Math.hypot(totalDx, totalDy) >= TAP_MAX_MOVE_PX) {
          gesture.moved = true;
        }

        if (
          gesture.mode === "pending" &&
          Math.hypot(totalDx, totalDy) >= PAN_ACTIVATION_THRESHOLD_PX
        ) {
          gesture.mode = "pan";
        }

        if (gesture.mode === "pan") {
          const rawCursor = hasCursorPosition
            ? cursorPosition
            : {
                x: getRemoteWidth() / 2,
                y: getRemoteHeight() / 2,
              };
          const effectiveScale = Math.max(0.0001, fitScale * zoomScale);
          const visible = getVisibleRemoteBounds(effectiveScale);
          const baseCursor = {
            x: clampValue(rawCursor.x, visible.left, visible.right),
            y: clampValue(rawCursor.y, visible.top, visible.bottom),
          };
          moveCursorWithPan(stepX, stepY, false, baseCursor);
          return;
        }

        if (gesture.mode === "drag") {
          sendDragMoveFromStep(stepX, stepY);
          return;
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
        cancelPendingTap();
        if (threeFingerScrollGesture) {
          if (
            e.touches.length === 3 &&
            handleThreeFingerScrollMove(e.touches)
          ) {
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
          if (
            e.touches.length === 3 &&
            handleThreeFingerScrollMove(e.touches)
          ) {
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
            const isTwoFingerTapCandidate = updateTwoFingerTapGesture(
              e.touches,
            );
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
                pinchGesture.initialZoom *
                  (distance / pinchGesture.initialDistance),
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
          if (
            e.touches.length === 3 &&
            handleThreeFingerScrollMove(e.touches)
          ) {
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

      overlayEl.addEventListener("touchstart", handleViewportTouchStart, {
        passive: false,
      });
      overlayEl.addEventListener("touchmove", handleViewportTouchMove, {
        passive: false,
      });
      overlayEl.addEventListener("touchend", handleViewportTouchEnd, {
        passive: false,
      });
      overlayEl.addEventListener("touchcancel", handleViewportTouchEnd, {
        passive: false,
      });

      // Mouse (desktop)
      overlayEl.addEventListener("mousedown", handleMouse);
      overlayEl.addEventListener("mouseup", handleMouse);
      overlayEl.addEventListener("mousemove", handleMouse);
      overlayEl.addEventListener("wheel", handleWheel, { passive: false });
      overlayEl.addEventListener("contextmenu", handleContextMenu);

      function remoteCoordsFromClient(
        clientX: number,
        clientY: number,
      ): { x: number; y: number } {
        // The canvas rect reflects the current pan/scale, so mapping through
        // it converts overlay coordinates into framebuffer coordinates.
        const rect = canvasEl.getBoundingClientRect();
        const scale = rect.width > 0 ? getRemoteWidth() / rect.width : 1;
        return {
          x: Math.round((clientX - rect.left) * scale),
          y: Math.round((clientY - rect.top) * scale),
        };
      }

      function handleMouse(e: MouseEvent) {
        const { x, y } = remoteCoordsFromClient(e.clientX, e.clientY);
        sendMouse(x, y, {
          left: !!(e.buttons & 1),
          middle: !!(e.buttons & 4),
          right: !!(e.buttons & 2),
        });
        e.preventDefault();
      }

      function handleWheel(e: WheelEvent) {
        const { x, y } = remoteCoordsFromClient(e.clientX, e.clientY);
        sendWheelFromRemote(x, y, e.deltaY < 0, e.deltaY > 0);
        e.preventDefault();
      }

      function handleContextMenu(e: MouseEvent) {
        e.preventDefault();
      }

      // Resize the remote desktop to the viewport size (in device pixels for
      // HiDPI). noVNC pulls the actual target from rfb.computeTargetSize when
      // we poke requestResize(). Compare against the real framebuffer — not
      // the last request — so a request that never landed can't permanently
      // swallow future resizes to the same target.
      function doResize() {
        if (!canSendResize) return;

        const { width: w, height: h } = computeSessionSizeTarget();

        if (getRemoteWidth() === w && getRemoteHeight() === h) {
          pendingResizeTarget = null;
          pendingResizeRetries = 0;
          clearResizeRetryTimer();
          return;
        }
        pendingResizeTarget = { width: w, height: h };
        pendingResizeRetries = 0;

        rfb.requestResize();
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
          const remoteWidth = getRemoteWidth();
          const remoteHeight = getRemoteHeight();

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
          rfb.requestResize();
          queueResizeRetry();
        }, RESIZE_RETRY_DELAY_MS);
      }

      // Framebuffer size changes (server applied a resize, or initial size).
      function handleFbResize(event: Event) {
        const { width, height } = (
          event as CustomEvent<{ width: number; height: number }>
        ).detail;
        if (!useHiDpiSessionSizing && !touchMinimumSize) {
          touchMinimumSize = { width, height };
        }
        if (
          pendingResizeTarget &&
          width === pendingResizeTarget.width &&
          height === pendingResizeTarget.height
        ) {
          pendingResizeTarget = null;
          pendingResizeRetries = 0;
          clearResizeRetryTimer();
        }
        applyDisplayTransform();

        void fetch("/api/app/display", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ width, height }),
        }).catch(() => {});
      }
      rfb.addEventListener("fbresize", handleFbResize);

      window.addEventListener("resize", scheduleResize);
      window.addEventListener("orientationchange", scheduleResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", scheduleResize);
      }

      // devicePixelRatio changes (moving the window between monitors with
      // different scale factors, browser zoom) don't reliably fire a resize
      // event, but they change the HiDPI session target. matchMedia only
      // fires when the current dpr stops matching, so re-arm on each change.
      let dprQuery: MediaQueryList | null = null;
      function handleDprChange(): void {
        watchDprChanges();
        scheduleResize();
      }
      function watchDprChanges(): void {
        dprQuery?.removeEventListener("change", handleDprChange);
        dprQuery = window.matchMedia(
          `(resolution: ${window.devicePixelRatio || 1}dppx)`,
        );
        dprQuery.addEventListener("change", handleDprChange);
      }
      if (useHiDpiSessionSizing) watchDprChanges();

      // RFB lifecycle events
      rfb.addEventListener("connect", () => {
        if (connectionId !== connectionIdRef.current) return;
        setState("connected");
        canSendResize = true;
        doResize();
        scheduleResize();
      });

      rfb.addEventListener("disconnect", (event) => {
        if (connectionId !== connectionIdRef.current) return;
        canSendResize = false;
        if (manualDisconnectRef.current) {
          setState("disconnected");
          return;
        }
        const clean = event.detail.clean;
        setError(
          (prev) =>
            prev ||
            (clean
              ? "Disconnected by the server"
              : "Connection closed unexpectedly"),
        );
        setState("error");
      });

      rfb.addEventListener("securityfailure", (event) => {
        if (connectionId !== connectionIdRef.current) return;
        const reason = event.detail.reason;
        setError(
          reason
            ? `VNC authentication failed: ${reason}`
            : "VNC authentication failed",
        );
      });

      rfb.addEventListener("credentialsrequired", () => {
        if (connectionId !== connectionIdRef.current) return;
        setError("VNC server requires credentials that are not configured");
      });

      // Clipboard from remote (noVNC handles the extended/Unicode transport)
      rfb.addEventListener("clipboard", (event) => {
        if (connectionId !== connectionIdRef.current) return;
        setClipboardText(event.detail.text);
      });

      // Keyboard: reuse one noVNC Keyboard per container; the handler routes
      // through rfbRef so it goes inert after disconnect.
      if (!keyboardRef.current || keyboardTargetRef.current !== containerEl) {
        keyboardRef.current?.ungrab();
        const keyboard = new Keyboard(containerEl);
        keyboard.onkeyevent = (keysym, code, down) => {
          rfbRef.current?.sendKey(keysym, code, down);
        };
        keyboard.grab();
        keyboardRef.current = keyboard;
        keyboardTargetRef.current = containerEl;
      }

      cleanupRef.current = () => {
        rfb.removeEventListener("fbresize", handleFbResize);
        overlayEl.removeEventListener("touchstart", handleViewportTouchStart);
        overlayEl.removeEventListener("touchmove", handleViewportTouchMove);
        overlayEl.removeEventListener("touchend", handleViewportTouchEnd);
        overlayEl.removeEventListener("touchcancel", handleViewportTouchEnd);
        overlayEl.removeEventListener("mousedown", handleMouse);
        overlayEl.removeEventListener("mouseup", handleMouse);
        overlayEl.removeEventListener("mousemove", handleMouse);
        overlayEl.removeEventListener("wheel", handleWheel);
        overlayEl.removeEventListener("contextmenu", handleContextMenu);
        window.removeEventListener("resize", scheduleResize);
        window.removeEventListener("orientationchange", scheduleResize);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener("resize", scheduleResize);
        }
        dprQuery?.removeEventListener("change", handleDprChange);
        dprQuery = null;
        if (overlayEl.parentElement === containerEl) {
          containerEl.removeChild(overlayEl);
        }
        if (resizeTimer.current) clearTimeout(resizeTimer.current);
        clearResizeRetryTimer();
      };
    },
    [containerRef],
  );

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    connectionIdRef.current += 1;
    cleanupRef.current?.();
    cleanupRef.current = null;
    const rfb = rfbRef.current;
    rfbRef.current = null;
    if (rfb) {
      try {
        rfb.disconnect();
      } catch {
        // Already torn down.
      }
    }
    setState("disconnected");
  }, []);

  const sendClipboard = useCallback((text: string): boolean => {
    const rfb = rfbRef.current;
    if (!rfb || !rfb.connected) return false;
    rfb.clipboardPasteFrom(text);
    return true;
  }, []);

  const sendKey = useCallback((keysym: number, pressed: boolean) => {
    rfbRef.current?.sendKey(keysym, null, pressed);
  }, []);

  const sendKeyCombo = useCallback((keysyms: number[]) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const k of keysyms) rfb.sendKey(k, null, true);
    for (let i = keysyms.length - 1; i >= 0; i--)
      rfb.sendKey(keysyms[i], null, false);
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
    sendKeyCombo,
    state,
    error,
    clipboardText,
  };
}
