import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { useGuacamole } from "./useGuacamole";

const FAB_SIZE = 48;
const FAB_MARGIN = 16;
const DRAG_THRESHOLD = 6;
const TOOLBAR_WIDTH = 260;
const TOOLBAR_GAP = 12;
const TOOLBAR_MIN_HEIGHT = 140;

interface FabPosition {
	x: number;
	y: number;
}

interface FabDragState {
	pointerId: number;
	startX: number;
	startY: number;
	originX: number;
	originY: number;
	dragged: boolean;
}

interface ConnectionTarget {
	vncHost: string;
	vncPort: string;
}

export default function App() {
	const containerRef = useRef<HTMLDivElement>(null);
	const {
		connect,
		disconnect,
		sendClipboard,
		sendCtrlAltDel,
		state,
		error,
		clipboardText,
	} = useGuacamole(containerRef);

	const [toolbarOpen, setToolbarOpen] = useState(false);
	const [clipboardInput, setClipboardInput] = useState("");
	const [fabPosition, setFabPosition] = useState<FabPosition | null>(null);
	const [fabDragging, setFabDragging] = useState(false);
	const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null);
	const [connectionTargetError, setConnectionTargetError] = useState<string | null>(null);
	const hiddenInputRef = useRef<HTMLInputElement>(null);
	const clipboardInputRef = useRef<HTMLTextAreaElement>(null);
	const fabDragStateRef = useRef<FabDragState | null>(null);
	const suppressFabClickRef = useRef(false);
	const showKeyboardShortcut = useMemo(() => {
		const ua = navigator.userAgent;
		const isIPadOS =
			navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
		const isIOS = /iPhone|iPad|iPod/i.test(ua) || isIPadOS;
		const isAndroid = /Android/i.test(ua);
		return isIOS || isAndroid;
	}, []);

	// Load connection target details for manual connect UI.
	useEffect(() => {
		let cancelled = false;

		const loadConnectionTarget = async () => {
			try {
				const res = await fetch("/api/config");
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as ConnectionTarget;
				if (cancelled) return;
				setConnectionTarget({
					vncHost: data.vncHost,
					vncPort: data.vncPort,
				});
				setConnectionTargetError(null);
			} catch {
				if (cancelled) return;
				setConnectionTargetError("Unable to load connection target");
			}
		};

		loadConnectionTarget();

		return () => {
			cancelled = true;
		};
	}, []);

	// Disconnect on unmount.
	useEffect(() => {
		return () => {
			disconnect();
		};
	}, [disconnect]);

	// Sync remote clipboard to input
	useEffect(() => {
		if (clipboardText) setClipboardInput(clipboardText);
	}, [clipboardText]);

	const toggleToolbar = useCallback(() => {
		setToolbarOpen((prev) => !prev);
	}, []);

	const clampFabPosition = useCallback((x: number, y: number): FabPosition => {
		const vp = window.visualViewport;
		const viewportWidth = vp ? vp.width : window.innerWidth;
		const viewportHeight = vp ? vp.height : window.innerHeight;
		const offsetX = vp ? vp.offsetLeft : 0;
		const offsetY = vp ? vp.offsetTop : 0;
		const minX = offsetX + FAB_MARGIN;
		const minY = offsetY + FAB_MARGIN;
		const maxX = offsetX + Math.max(FAB_MARGIN, viewportWidth - FAB_SIZE - FAB_MARGIN);
		const maxY = offsetY + Math.max(FAB_MARGIN, viewportHeight - FAB_SIZE - FAB_MARGIN);

		return {
			x: Math.min(Math.max(x, minX), maxX),
			y: Math.min(Math.max(y, minY), maxY),
		};
	}, []);

	const getDefaultFabPosition = useCallback((): FabPosition => {
		const vp = window.visualViewport;
		const viewportWidth = vp ? vp.width : window.innerWidth;
		const offsetX = vp ? vp.offsetLeft : 0;
		const offsetY = vp ? vp.offsetTop : 0;
		return clampFabPosition(
			offsetX + viewportWidth - FAB_SIZE - FAB_MARGIN,
			offsetY + FAB_MARGIN,
		);
	}, [clampFabPosition]);

	const handleFabPointerDown = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			if (e.button !== 0 && e.pointerType !== "touch" && e.pointerType !== "pen") {
				return;
			}

			const current = fabPosition ?? getDefaultFabPosition();
			fabDragStateRef.current = {
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				originX: current.x,
				originY: current.y,
				dragged: false,
			};

			e.currentTarget.setPointerCapture(e.pointerId);
		},
		[fabPosition, getDefaultFabPosition],
	);

	const handleFabPointerMove = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			const dragState = fabDragStateRef.current;
			if (!dragState || dragState.pointerId !== e.pointerId) return;

			const dx = e.clientX - dragState.startX;
			const dy = e.clientY - dragState.startY;
			if (!dragState.dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
				dragState.dragged = true;
				setFabDragging(true);
			}

			if (!dragState.dragged) return;
			const next = clampFabPosition(dragState.originX + dx, dragState.originY + dy);
			setFabPosition(next);
			suppressFabClickRef.current = true;
			e.preventDefault();
		},
		[clampFabPosition],
	);

	const endFabDrag = useCallback((pointerId: number) => {
		const dragState = fabDragStateRef.current;
		if (!dragState || dragState.pointerId !== pointerId) return;

		fabDragStateRef.current = null;
		setFabDragging(false);
	}, []);

	const handleFabPointerUp = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			endFabDrag(e.pointerId);
		},
		[endFabDrag],
	);

	const handleFabPointerCancel = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			endFabDrag(e.pointerId);
		},
		[endFabDrag],
	);

	const handleFabClick = useCallback(() => {
		if (suppressFabClickRef.current) {
			suppressFabClickRef.current = false;
			return;
		}
		toggleToolbar();
	}, [toggleToolbar]);

	const handlePasteClipboard = useCallback(() => {
		sendClipboard(clipboardInput);
	}, [clipboardInput, sendClipboard]);

	const selectClipboardText = useCallback((target: HTMLTextAreaElement) => {
		target.focus();
		target.select();
		target.setSelectionRange(0, target.value.length);
	}, []);

	const handleClipboardFocus = useCallback(
		(e: React.FocusEvent<HTMLTextAreaElement>) => {
			selectClipboardText(e.currentTarget);
		},
		[selectClipboardText],
	);

	const handleClipboardClick = useCallback(
		(e: React.MouseEvent<HTMLTextAreaElement>) => {
			selectClipboardText(e.currentTarget);
		},
		[selectClipboardText],
	);

	const handleCopyClipboard = useCallback(async () => {
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(clipboardInput);
				return;
			} catch {
				// Fallback below for environments where Clipboard API is unavailable.
			}
		}

		const input = clipboardInputRef.current;
		if (!input) return;

		const previousStart = input.selectionStart;
		const previousEnd = input.selectionEnd;
		selectClipboardText(input);
		document.execCommand("copy");
		if (previousStart !== null && previousEnd !== null) {
			input.setSelectionRange(previousStart, previousEnd);
		}
	}, [clipboardInput, selectClipboardText]);

	const handleShowKeyboard = useCallback(() => {
		hiddenInputRef.current?.focus();
		setToolbarOpen(false);
	}, []);

	const handleDisconnect = useCallback(() => {
		disconnect();
		setToolbarOpen(false);
	}, [disconnect]);

	const handleConnect = useCallback(() => {
		disconnect();
		connect();
	}, [disconnect, connect]);

	useEffect(() => {
		const keepFabInViewport = () => {
			setFabPosition((prev) => {
				if (!prev) return prev;
				return clampFabPosition(prev.x, prev.y);
			});
		};

		window.addEventListener("resize", keepFabInViewport);
		if (window.visualViewport) {
			window.visualViewport.addEventListener("resize", keepFabInViewport);
		}

		return () => {
			window.removeEventListener("resize", keepFabInViewport);
			if (window.visualViewport) {
				window.visualViewport.removeEventListener("resize", keepFabInViewport);
			}
		};
	}, [clampFabPosition]);

	const resolvedFabPosition = fabPosition ?? getDefaultFabPosition();

	const toolbarStyle = (() => {
		const vp = window.visualViewport;
		const viewportWidth = vp ? vp.width : window.innerWidth;
		const viewportHeight = vp ? vp.height : window.innerHeight;
		const offsetX = vp ? vp.offsetLeft : 0;
		const offsetY = vp ? vp.offsetTop : 0;

		const minLeft = offsetX + FAB_MARGIN;
		const maxLeft =
			offsetX + Math.max(FAB_MARGIN, viewportWidth - TOOLBAR_WIDTH - FAB_MARGIN);
		const desiredLeft = resolvedFabPosition.x + FAB_SIZE - TOOLBAR_WIDTH;
		const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

		const topBelow = resolvedFabPosition.y + FAB_SIZE + TOOLBAR_GAP;
		const topAboveAnchor = resolvedFabPosition.y - TOOLBAR_GAP;
		const availableBelow = offsetY + viewportHeight - topBelow - FAB_MARGIN;
		const availableAbove = topAboveAnchor - offsetY - FAB_MARGIN;
		const placeBelow =
			availableBelow >= TOOLBAR_MIN_HEIGHT || availableBelow >= availableAbove;
		const maxHeight = Math.max(
			TOOLBAR_MIN_HEIGHT,
			Math.floor(placeBelow ? availableBelow : availableAbove),
		);

		if (placeBelow) {
			return {
				left: `${left}px`,
				top: `${topBelow}px`,
				right: "auto",
				bottom: "auto",
				transform: "none",
				maxHeight: `${maxHeight}px`,
			};
		}

		return {
			left: `${left}px`,
			top: `${topAboveAnchor}px`,
			right: "auto",
			bottom: "auto",
			transform: "translateY(-100%)",
			maxHeight: `${maxHeight}px`,
		};
	})();

	return (
		<div className="app">
			<div ref={containerRef} className="display-container" />

			{/* Hidden input for mobile keyboard */}
			<input
				ref={hiddenInputRef}
				className="hidden-input"
				type="text"
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				aria-hidden="true"
			/>

			{/* Connection overlay */}
			{state !== "connected" && (
				<div className="overlay">
					{state === "connecting" && (
						<div className="status">
							<p>Connecting...</p>
							<p>
								{connectionTarget
									? `Target: ${connectionTarget.vncHost}:${connectionTarget.vncPort}`
									: connectionTargetError || "Target: loading..."}
							</p>
						</div>
					)}
					{state !== "connecting" && (
						<div className="status">
							<p>{state === "error" ? "Connection failed" : "Ready to connect"}</p>
							<p>
								{connectionTarget
									? `Target: ${connectionTarget.vncHost}:${connectionTarget.vncPort}`
									: connectionTargetError || "Target: loading..."}
							</p>
							{state === "error" && error && <p>Error: {error}</p>}
							<button type="button" onClick={handleConnect} className="btn">
								Connect
							</button>
						</div>
					)}
				</div>
			)}

			{/* FAB */}
			{state === "connected" && (
				<button
					type="button"
					className={`fab ${toolbarOpen ? "fab-active" : ""} ${fabDragging ? "fab-dragging" : ""}`}
					style={{
						left: `${resolvedFabPosition.x}px`,
						top: `${resolvedFabPosition.y}px`,
						right: "auto",
						bottom: "auto",
					}}
					onClick={handleFabClick}
					onPointerDown={handleFabPointerDown}
					onPointerMove={handleFabPointerMove}
					onPointerUp={handleFabPointerUp}
					onPointerCancel={handleFabPointerCancel}
					aria-label="Toggle toolbar"
				>
					{toolbarOpen ? "\u2715" : "\u2630"}
				</button>
			)}

			{/* Toolbar drawer */}
			{toolbarOpen && (
				<div className="toolbar" style={toolbarStyle}>
					<div className="toolbar-section">
						<label className="toolbar-label" htmlFor="clipboard-input">
							Clipboard
						</label>
						<textarea
							id="clipboard-input"
							ref={clipboardInputRef}
							className="clipboard-input"
							value={clipboardInput}
							onChange={(e) => setClipboardInput(e.target.value)}
							onFocus={handleClipboardFocus}
							onClick={handleClipboardClick}
							rows={3}
						/>
						<div className="clipboard-actions">
							<button type="button" className="btn btn-sm" onClick={handlePasteClipboard}>
								Send to remote
							</button>
							<button type="button" className="btn btn-sm" onClick={handleCopyClipboard}>
								Copy
							</button>
						</div>
					</div>

					<div className="toolbar-section toolbar-buttons">
						{showKeyboardShortcut && (
							<button type="button" className="btn btn-sm" onClick={handleShowKeyboard}>
								Show Keyboard
							</button>
						)}
						<button type="button" className="btn btn-sm" onClick={sendCtrlAltDel}>
							Ctrl+Alt+Del
						</button>
						<button type="button" className="btn btn-sm btn-danger" onClick={handleDisconnect}>
							Disconnect
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
