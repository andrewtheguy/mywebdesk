import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { useGuacamole } from "./useGuacamole";

const FAB_SIZE = 48;
const FAB_MARGIN = 16;
const DRAG_THRESHOLD = 6;
const TOOLBAR_WIDTH = 260;
const TOOLBAR_GAP = 12;
const TOOLBAR_MIN_HEIGHT = 140;
const CTRL_KEYSYM = 0xffe3;
const V_KEYSYM = 0x0076;

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

interface ViewportState {
	width: number;
	height: number;
	offsetX: number;
	offsetY: number;
}

function getViewportState(): ViewportState {
	if (typeof window === "undefined") {
		return {
			width: 0,
			height: 0,
			offsetX: 0,
			offsetY: 0,
		};
	}

	const vp = window.visualViewport;
	return {
		width: vp ? vp.width : window.innerWidth,
		height: vp ? vp.height : window.innerHeight,
		offsetX: vp ? vp.offsetLeft : 0,
		offsetY: vp ? vp.offsetTop : 0,
	};
}

export default function App() {
	const containerRef = useRef<HTMLDivElement>(null);
	const {
		connect,
		disconnect,
		sendClipboard,
		sendKey,
		sendCtrlAltDel,
		state,
		error,
		clipboardText,
	} = useGuacamole(containerRef);

	const [toolbarOpen, setToolbarOpen] = useState(false);
	const [clipboardInput, setClipboardInput] = useState("");
	const [fabPosition, setFabPosition] = useState<FabPosition | null>(null);
	const [fabDragging, setFabDragging] = useState(false);
	const [connectionTarget, setConnectionTarget] =
		useState<ConnectionTarget | null>(null);
	const [connectionTargetError, setConnectionTargetError] = useState<
		string | null
	>(null);
	const [connectionPassword, setConnectionPassword] = useState("");
	const [isDisplayFocused, setIsDisplayFocused] = useState(false);
	const [viewportState, setViewportState] = useState<ViewportState>(() =>
		getViewportState(),
	);
	const hiddenInputRef = useRef<HTMLInputElement>(null);
	const clipboardInputRef = useRef<HTMLTextAreaElement>(null);
	const lastSyncedRemoteClipboardRef = useRef("");
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
				const payload: unknown = await res.json();
				if (!payload || typeof payload !== "object") {
					console.error(
						"Invalid /api/config payload (expected object):",
						payload,
					);
					throw new Error("Invalid config response: expected object payload");
				}

				const { vncHost, vncPort } = payload as {
					vncHost?: unknown;
					vncPort?: unknown;
				};

				if (typeof vncHost !== "string" || vncHost.trim().length === 0) {
					console.error("Invalid /api/config payload (vncHost):", payload);
					throw new Error(
						"Invalid config response: vncHost must be a non-empty string",
					);
				}

				let normalizedPort: string;
				if (typeof vncPort === "number" && Number.isFinite(vncPort)) {
					normalizedPort = String(vncPort);
				} else if (typeof vncPort === "string" && vncPort.trim().length > 0) {
					normalizedPort = vncPort.trim();
				} else {
					console.error("Invalid /api/config payload (vncPort):", payload);
					throw new Error(
						"Invalid config response: vncPort must be a non-empty string or number",
					);
				}

				if (cancelled) return;
				setConnectionTarget({
					vncHost: vncHost.trim(),
					vncPort: normalizedPort,
				});
				setConnectionTargetError(null);
			} catch (err) {
				if (cancelled) return;
				console.error("Failed loading connection target:", err);
				setConnectionTargetError(
					err instanceof Error
						? err.message
						: "Unable to load connection target",
				);
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
		if (!clipboardText) return;
		setClipboardInput(clipboardText);
		if (clipboardText === lastSyncedRemoteClipboardRef.current) return;
		lastSyncedRemoteClipboardRef.current = clipboardText;
		if (!navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(clipboardText).catch(() => {
			// Silent fallback when Clipboard API write is unavailable or blocked.
		});
	}, [clipboardText]);

	// Clear password once a connection succeeds.
	useEffect(() => {
		if (state === "connected") {
			setConnectionPassword("");
			hiddenInputRef.current?.focus();
		} else {
			setIsDisplayFocused(false);
		}
	}, [state]);

	const readLocalClipboardText = useCallback(async (): Promise<
		string | null
	> => {
		if (!navigator.clipboard?.readText) return null;
		try {
			return await navigator.clipboard.readText();
		} catch {
			return null;
		}
	}, []);

	const toggleToolbar = useCallback(() => {
		setToolbarOpen((prev) => !prev);
	}, []);

	// Track viewport size/offset from visualViewport (fallback to window).
	useEffect(() => {
		const updateViewportState = () => {
			const next = getViewportState();
			setViewportState((prev) => {
				if (
					prev.width === next.width &&
					prev.height === next.height &&
					prev.offsetX === next.offsetX &&
					prev.offsetY === next.offsetY
				) {
					return prev;
				}
				return next;
			});
		};

		updateViewportState();
		window.addEventListener("resize", updateViewportState);
		const vp = window.visualViewport;
		if (vp) {
			vp.addEventListener("resize", updateViewportState);
			vp.addEventListener("scroll", updateViewportState);
		}

		return () => {
			window.removeEventListener("resize", updateViewportState);
			if (vp) {
				vp.removeEventListener("resize", updateViewportState);
				vp.removeEventListener("scroll", updateViewportState);
			}
		};
	}, []);

	const clampFabPosition = useCallback(
		(x: number, y: number): FabPosition => {
			const minX = viewportState.offsetX + FAB_MARGIN;
			const minY = viewportState.offsetY + FAB_MARGIN;
			const maxX =
				viewportState.offsetX +
				Math.max(FAB_MARGIN, viewportState.width - FAB_SIZE - FAB_MARGIN);
			const maxY =
				viewportState.offsetY +
				Math.max(FAB_MARGIN, viewportState.height - FAB_SIZE - FAB_MARGIN);

			return {
				x: Math.min(Math.max(x, minX), maxX),
				y: Math.min(Math.max(y, minY), maxY),
			};
		},
		[viewportState],
	);

	const getDefaultFabPosition = useCallback((): FabPosition => {
		return clampFabPosition(
			viewportState.offsetX + viewportState.width - FAB_SIZE - FAB_MARGIN,
			viewportState.offsetY + FAB_MARGIN,
		);
	}, [clampFabPosition, viewportState]);

	const handleFabPointerDown = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			if (
				e.button !== 0 &&
				e.pointerType !== "touch" &&
				e.pointerType !== "pen"
			) {
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
			const next = clampFabPosition(
				dragState.originX + dx,
				dragState.originY + dy,
			);
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

	const handleDisplayFocus = useCallback(() => {
		setIsDisplayFocused(true);
	}, []);

	const handleDisplayBlur = useCallback(() => {
		setIsDisplayFocused(false);
	}, []);

	const handleDisplayPointerDown = useCallback(() => {
		hiddenInputRef.current?.focus();
	}, []);

	const handleDisplayKeyDownCapture = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (state !== "connected" || !isDisplayFocused) return;
			if (e.repeat || e.altKey) return;
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "v") return;

			e.preventDefault();
			e.stopPropagation();

			void (async () => {
				const text = await readLocalClipboardText();
				if (text !== null) {
					setClipboardInput(text);
					sendClipboard(text);
				}
				sendKey(CTRL_KEYSYM, true);
				sendKey(V_KEYSYM, true);
				sendKey(V_KEYSYM, false);
				sendKey(CTRL_KEYSYM, false);
			})();
		},
		[isDisplayFocused, readLocalClipboardText, sendClipboard, sendKey, state],
	);

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
		setConnectionPassword("");
		setToolbarOpen(false);
	}, [disconnect]);

	const handleConnect = useCallback(() => {
		disconnect();
		connect({ password: connectionPassword });
	}, [disconnect, connect, connectionPassword]);

	const handleConnectSubmit = useCallback(
		(e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			handleConnect();
		},
		[handleConnect],
	);

	useEffect(() => {
		setFabPosition((prev) => {
			if (!prev) return prev;
			return clampFabPosition(prev.x, prev.y);
		});
	}, [clampFabPosition]);

	const resolvedFabPosition = useMemo(
		() => fabPosition ?? getDefaultFabPosition(),
		[fabPosition, getDefaultFabPosition],
	);

	const toolbarStyle = useMemo(() => {
		const minLeft = viewportState.offsetX + FAB_MARGIN;
		const maxLeft =
			viewportState.offsetX +
			Math.max(FAB_MARGIN, viewportState.width - TOOLBAR_WIDTH - FAB_MARGIN);
		const desiredLeft = resolvedFabPosition.x + FAB_SIZE - TOOLBAR_WIDTH;
		const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

		const topBelow = resolvedFabPosition.y + FAB_SIZE + TOOLBAR_GAP;
		const topAboveAnchor = resolvedFabPosition.y - TOOLBAR_GAP;
		const availableBelow =
			viewportState.offsetY + viewportState.height - topBelow - FAB_MARGIN;
		const availableAbove = topAboveAnchor - viewportState.offsetY - FAB_MARGIN;
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
	}, [resolvedFabPosition, viewportState]);

	return (
		<div className="app">
			<div
				ref={containerRef}
				className="display-container"
				role="application"
				aria-label="Remote display"
				onFocus={handleDisplayFocus}
				onBlur={handleDisplayBlur}
				onPointerDown={handleDisplayPointerDown}
				onKeyDownCapture={handleDisplayKeyDownCapture}
			>
				{/* Hidden input for mobile keyboard */}
				<input
					ref={hiddenInputRef}
					className="hidden-input"
					type="text"
					autoCapitalize="off"
					autoCorrect="off"
					autoComplete="off"
				/>
			</div>

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
							<p>
								{state === "error" ? "Connection failed" : "Ready to connect"}
							</p>
							<p>
								{connectionTarget
									? `Target: ${connectionTarget.vncHost}:${connectionTarget.vncPort}`
									: connectionTargetError || "Target: loading..."}
							</p>
							{state === "error" && error && <p>Error: {error}</p>}
							<form onSubmit={handleConnectSubmit}>
								<label
									htmlFor="connect-password"
									className="connect-password-label"
								>
									VNC Password
								</label>
								<input
									id="connect-password"
									type="password"
									className="connect-password-input"
									value={connectionPassword}
									onChange={(e) => setConnectionPassword(e.target.value)}
									autoComplete="current-password"
								/>
								<button type="submit" className="btn">
									Connect
								</button>
							</form>
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
							<button
								type="button"
								className="btn btn-sm"
								onClick={handlePasteClipboard}
							>
								Send to remote
							</button>
							<button
								type="button"
								className="btn btn-sm"
								onClick={handleCopyClipboard}
							>
								Copy
							</button>
						</div>
					</div>

					<div className="toolbar-section toolbar-buttons">
						{showKeyboardShortcut && (
							<button
								type="button"
								className="btn btn-sm"
								onClick={handleShowKeyboard}
							>
								Show Keyboard
							</button>
						)}
						<button
							type="button"
							className="btn btn-sm"
							onClick={sendCtrlAltDel}
						>
							Ctrl+Alt+Del
						</button>
						<button
							type="button"
							className="btn btn-sm btn-danger"
							onClick={handleDisconnect}
						>
							Disconnect
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
