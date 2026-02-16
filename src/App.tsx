import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { useGuacamole } from "./useGuacamole";

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
	const [keyboardVisible, setKeyboardVisible] = useState(false);
	const hiddenInputRef = useRef<HTMLInputElement>(null);

	// Auto-connect on mount
	useEffect(() => {
		connect();
	}, [connect]);

	// Sync remote clipboard to input
	useEffect(() => {
		if (clipboardText) setClipboardInput(clipboardText);
	}, [clipboardText]);

	const toggleToolbar = useCallback(() => {
		setToolbarOpen((prev) => !prev);
	}, []);

	const handlePasteClipboard = useCallback(() => {
		sendClipboard(clipboardInput);
	}, [clipboardInput, sendClipboard]);

	const toggleKeyboard = useCallback(() => {
		setKeyboardVisible((prev) => {
			const next = !prev;
			if (next && hiddenInputRef.current) {
				hiddenInputRef.current.focus();
			} else if (hiddenInputRef.current) {
				hiddenInputRef.current.blur();
			}
			return next;
		});
	}, []);

	const handleDisconnect = useCallback(() => {
		disconnect();
		setToolbarOpen(false);
	}, [disconnect]);

	const handleReconnect = useCallback(() => {
		disconnect();
		connect();
	}, [disconnect, connect]);

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
					{state === "connecting" && <div className="status">Connecting...</div>}
					{state === "disconnected" && (
						<div className="status">
							<p>Disconnected</p>
							<button type="button" onClick={handleReconnect} className="btn">
								Reconnect
							</button>
						</div>
					)}
					{state === "error" && (
						<div className="status error">
							<p>Error: {error}</p>
							<button type="button" onClick={handleReconnect} className="btn">
								Retry
							</button>
						</div>
					)}
				</div>
			)}

			{/* FAB */}
			{state === "connected" && (
				<button
					type="button"
					className={`fab ${toolbarOpen ? "fab-active" : ""}`}
					onClick={toggleToolbar}
					aria-label="Toggle toolbar"
				>
					{toolbarOpen ? "\u2715" : "\u2630"}
				</button>
			)}

			{/* Toolbar drawer */}
			{toolbarOpen && (
				<div className="toolbar">
					<div className="toolbar-section">
						<label className="toolbar-label" htmlFor="clipboard-input">
							Clipboard
						</label>
						<textarea
							id="clipboard-input"
							className="clipboard-input"
							value={clipboardInput}
							onChange={(e) => setClipboardInput(e.target.value)}
							rows={3}
						/>
						<button type="button" className="btn btn-sm" onClick={handlePasteClipboard}>
							Send to remote
						</button>
					</div>

					<div className="toolbar-section toolbar-buttons">
						<button type="button" className="btn btn-sm" onClick={toggleKeyboard}>
							{keyboardVisible ? "Hide Keyboard" : "Show Keyboard"}
						</button>
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
