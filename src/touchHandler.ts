import type Guacamole from "guacamole-common-js";

const LONG_PRESS_MS = 500;
const LONG_PRESS_THRESHOLD_PX = 10;
const SCROLL_SENSITIVITY = 3;

interface TouchState {
	startX: number;
	startY: number;
	startTime: number;
	longPressTimer: ReturnType<typeof setTimeout> | null;
	isRightClick: boolean;
	isDragging: boolean;
}

export function attachTouchHandler(
	element: HTMLElement,
	sendMouseState: (state: Guacamole.Mouse.State) => void,
	MouseState: typeof Guacamole.Mouse.State,
): () => void {
	let touch: TouchState | null = null;
	let lastTwoFingerY = 0;

	function getCoords(e: Touch): { x: number; y: number } {
		const rect = element.getBoundingClientRect();
		return {
			x: Math.round(e.clientX - rect.left),
			y: Math.round(e.clientY - rect.top),
		};
	}

	function onTouchStart(e: TouchEvent) {
		// Two-finger scroll setup
		if (e.touches.length === 2) {
			e.preventDefault();
			lastTwoFingerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
			// Release any active single-touch drag
			if (touch) {
				clearLongPress();
				const { x, y } = getCoords(e.touches[0]);
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
				touch = null;
			}
			return;
		}

		if (e.touches.length !== 1) return;
		e.preventDefault();

		const { x, y } = getCoords(e.touches[0]);

		touch = {
			startX: x,
			startY: y,
			startTime: Date.now(),
			longPressTimer: null,
			isRightClick: false,
			isDragging: false,
		};

		// Start long-press detection
		touch.longPressTimer = setTimeout(() => {
			if (!touch) return;
			const dx = Math.abs(x - touch.startX);
			const dy = Math.abs(y - touch.startY);
			if (dx < LONG_PRESS_THRESHOLD_PX && dy < LONG_PRESS_THRESHOLD_PX) {
				touch.isRightClick = true;
				// Release left, press right
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
				sendMouseState(
					new MouseState(x, y, false, false, true, false, false),
				);
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
			}
		}, LONG_PRESS_MS);

		// Immediately send mousedown (left button)
		sendMouseState(new MouseState(x, y, true, false, false, false, false));
		touch.isDragging = true;
	}

	function clearLongPress() {
		if (touch?.longPressTimer) {
			clearTimeout(touch.longPressTimer);
			touch.longPressTimer = null;
		}
	}

	function onTouchMove(e: TouchEvent) {
		// Two-finger scroll
		if (e.touches.length === 2) {
			e.preventDefault();
			const currentY =
				(e.touches[0].clientY + e.touches[1].clientY) / 2;
			const deltaY = currentY - lastTwoFingerY;
			lastTwoFingerY = currentY;

			const { x, y } = getCoords(e.touches[0]);
			if (deltaY < -SCROLL_SENSITIVITY) {
				sendMouseState(
					new MouseState(x, y, false, false, false, true, false),
				);
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
			} else if (deltaY > SCROLL_SENSITIVITY) {
				sendMouseState(
					new MouseState(x, y, false, false, false, false, true),
				);
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
			}
			return;
		}

		if (!touch || e.touches.length !== 1) return;
		e.preventDefault();

		const { x, y } = getCoords(e.touches[0]);

		// Cancel long-press if moved too far
		const dx = Math.abs(x - touch.startX);
		const dy = Math.abs(y - touch.startY);
		if (dx > LONG_PRESS_THRESHOLD_PX || dy > LONG_PRESS_THRESHOLD_PX) {
			clearLongPress();
		}

		if (touch.isRightClick) return;

		// Send mousemove with left button held
		sendMouseState(new MouseState(x, y, true, false, false, false, false));
	}

	function onTouchEnd(e: TouchEvent) {
		if (!touch) return;
		e.preventDefault();

		clearLongPress();

		if (!touch.isRightClick) {
			const x = touch.startX;
			const y = touch.startY;
			// Use last known position if available from last touch
			const lastTouch = e.changedTouches[0];
			if (lastTouch) {
				const coords = getCoords(lastTouch);
				sendMouseState(
					new MouseState(
						coords.x,
						coords.y,
						false,
						false,
						false,
						false,
						false,
					),
				);
			} else {
				sendMouseState(
					new MouseState(x, y, false, false, false, false, false),
				);
			}
		}

		touch = null;
	}

	element.addEventListener("touchstart", onTouchStart, { passive: false });
	element.addEventListener("touchmove", onTouchMove, { passive: false });
	element.addEventListener("touchend", onTouchEnd, { passive: false });
	element.addEventListener("touchcancel", onTouchEnd, { passive: false });

	return () => {
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchmove", onTouchMove);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchEnd);
	};
}
