import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { SoftKeyboardPanel } from "./SoftKeyboard";
import { useGuacamole } from "./useGuacamole";

const FAB_SIZE = 36;
const FAB_COMBO_WIDTH = 80;
const FAB_MARGIN = 0;
const DRAG_THRESHOLD = 6;
const TOOLBAR_CONTENT_WIDTH = 260;
const TOOLBAR_HORIZONTAL_PADDING = 16;
const TOOLBAR_RENDERED_WIDTH =
  TOOLBAR_CONTENT_WIDTH + TOOLBAR_HORIZONTAL_PADDING * 2;
const TOOLBAR_GAP = 12;
const TOOLBAR_MIN_HEIGHT = 140;
const SOFT_KEYBOARD_HEIGHT = 280;
const CTRL_KEYSYM = 0xffe3;
const ALT_KEYSYM = 0xffe9;
const V_KEYSYM = 0x0076;
const R_KEYSYM = 0x0072;
const T_KEYSYM = 0x0074;
const W_KEYSYM = 0x0077;
const F4_KEYSYM = 0xffc1;
const F5_KEYSYM = 0xffc2;
const F11_KEYSYM = 0xffc8;
const AES_GCM_IV_SIZE = 12;
const CRC32_POLYNOMIAL = 0xedb88320;
const CLIPBOARD_NOTICE_DURATION_MS = 1800;
const SESSION_CHECK_TIMEOUT_MS = 10000;

const DESKTOP_BROWSER_BLOCKED_KEYS = [
  { label: "F5", keysyms: [F5_KEYSYM] },
  { label: "F11", keysyms: [F11_KEYSYM] },
  { label: "Ctrl+R", keysyms: [CTRL_KEYSYM, R_KEYSYM] },
  { label: "Ctrl+W", keysyms: [CTRL_KEYSYM, W_KEYSYM] },
  { label: "Ctrl+T", keysyms: [CTRL_KEYSYM, T_KEYSYM] },
  { label: "Alt+F4", keysyms: [ALT_KEYSYM, F4_KEYSYM] },
] as const;

type AuthState = "checking" | "unauthenticated" | "authenticated";

interface RemoteClipboardPayload {
  encryptedContent: Uint8Array;
  iv: Uint8Array;
  checksumCrc32: string;
  receivedAtMs: number;
  contentLengthBytes: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) === 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const tableIndex = (crc ^ bytes[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC32_TABLE[tableIndex];
  }
  const normalized = (crc ^ 0xffffffff) >>> 0;
  return normalized.toString(16).padStart(8, "0");
}

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
    sendKeyCombo,
    state,
    error,
    clipboardText,
  } = useGuacamole(containerRef);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [clipboardInput, setClipboardInput] = useState("");
  const [remoteClipboardPayload, setRemoteClipboardPayload] =
    useState<RemoteClipboardPayload | null>(null);
  const [isManualClipboardInputActive, setIsManualClipboardInputActive] =
    useState(false);
  const [clipboardSecurityError, setClipboardSecurityError] = useState<
    string | null
  >(null);
  const [fabPosition, setFabPosition] = useState<FabPosition | null>(null);
  const [fabDragging, setFabDragging] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [connectionTarget, setConnectionTarget] =
    useState<ConnectionTarget | null>(null);
  const [connectionTargetError, setConnectionTargetError] = useState<
    string | null
  >(null);
  const [sessionPhase, setSessionPhase] = useState<
    "checking" | "prompt" | "ready"
  >("checking");
  const sessionIdRef = useRef<string | null>(null);
  const [clipboardSendNotice, setClipboardSendNotice] = useState<string | null>(
    null,
  );
  const [isDisplayFocused, setIsDisplayFocused] = useState(false);
  const [showGestureHelp, setShowGestureHelp] = useState(false);
  const [softKeyboardOpen, setSoftKeyboardOpen] = useState(false);
  const [viewportState, setViewportState] = useState<ViewportState>(() =>
    getViewportState(),
  );
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const clipboardInputRef = useRef<HTMLTextAreaElement>(null);
  const lastSyncedRemoteClipboardRef = useRef("");
  const hasProcessedRemoteClipboardRef = useRef(false);
  const clipboardCryptoKeyRef = useRef<CryptoKey | null>(null);
  const clipboardSendNoticeTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
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
  const isCoarsePointer = useMemo(
    () => window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  // Check auth status on mount.
  useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/status");
        if (cancelled) return;
        if (res.ok) {
          const body: unknown = await res.json();
          if (
            body &&
            typeof body === "object" &&
            "authenticated" in body &&
            (body as { authenticated: boolean }).authenticated
          ) {
            setAuthState("authenticated");
            return;
          }
        }
      } catch {
        // Network error — treat as unauthenticated.
      }
      if (!cancelled) setAuthState("unauthenticated");
    };
    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load connection target details for manual connect UI.
  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;

    const loadConnectionTarget = async () => {
      try {
        const res = await fetch("/api/app/config");
        if (res.status === 401) {
          if (!cancelled) setAuthState("unauthenticated");
          return;
        }
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
  }, [authState]);

  // Session check after auth.
  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      if (cancelled) return;
      abort.abort();
      console.error("Session check timed out");
      setSessionPhase("ready");
    }, SESSION_CHECK_TIMEOUT_MS);

    const checkSession = async () => {
      try {
        const statusRes = await fetch("/api/app/session", {
          signal: abort.signal,
        });
        if (statusRes.status === 401) {
          if (!cancelled) setAuthState("unauthenticated");
          return;
        }
        if (cancelled) return;
        if (!statusRes.ok) {
          console.error("Session status check failed:", statusRes.status);
          setSessionPhase("ready");
          return;
        }
        const statusBody: unknown = await statusRes.json();
        const active =
          statusBody !== null &&
          typeof statusBody === "object" &&
          "active" in statusBody &&
          typeof (statusBody as { active: unknown }).active === "boolean"
            ? (statusBody as { active: boolean }).active
            : false;

        if (active) {
          setSessionPhase("prompt");
          return;
        }

        const claimRes = await fetch("/api/app/session", {
          method: "POST",
          signal: abort.signal,
        });
        if (cancelled) return;
        if (claimRes.ok) {
          const claimBody: unknown = await claimRes.json();
          const sessionId =
            claimBody !== null &&
            typeof claimBody === "object" &&
            "sessionId" in claimBody &&
            typeof (claimBody as { sessionId: unknown }).sessionId === "string"
              ? (claimBody as { sessionId: string }).sessionId
              : null;
          sessionIdRef.current = sessionId;
          setSessionPhase("ready");
        } else if (claimRes.status === 409) {
          setSessionPhase("prompt");
        } else {
          console.error("Session claim failed:", claimRes.status);
          setSessionPhase("ready");
        }
      } catch (err) {
        if (!cancelled && !abort.signal.aborted) {
          console.error("Session check error:", err);
          setSessionPhase("ready");
        }
      }
    };

    void checkSession();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [authState]);

  // Disconnect on unmount.
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  const getClipboardCryptoKey = useCallback(async (): Promise<CryptoKey> => {
    const existingKey = clipboardCryptoKeyRef.current;
    if (existingKey) return existingKey;
    const generatedKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    clipboardCryptoKeyRef.current = generatedKey;
    return generatedKey;
  }, []);

  const decryptRemoteClipboardPayload = useCallback(
    async (payload: RemoteClipboardPayload): Promise<string> => {
      const key = await getClipboardCryptoKey();
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: payload.iv as BufferSource,
        },
        key,
        payload.encryptedContent as BufferSource,
      );
      return new TextDecoder().decode(new Uint8Array(decryptedBuffer));
    },
    [getClipboardCryptoKey],
  );

  // Encrypt remote clipboard data for metadata-first rendering.
  useEffect(() => {
    if (state !== "connected") return;
    if (!hasProcessedRemoteClipboardRef.current && clipboardText.length === 0)
      return;

    let cancelled = false;

    const syncRemoteClipboard = async () => {
      const textBytes = new TextEncoder().encode(clipboardText);
      try {
        const key = await getClipboardCryptoKey();
        const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_SIZE));
        const encrypted = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
          },
          key,
          textBytes,
        );

        if (cancelled) return;
        hasProcessedRemoteClipboardRef.current = true;
        setRemoteClipboardPayload({
          encryptedContent: new Uint8Array(encrypted),
          iv: new Uint8Array(iv),
          checksumCrc32: computeCrc32Hex(textBytes),
          receivedAtMs: Date.now(),
          contentLengthBytes: textBytes.byteLength,
        });
        setClipboardSecurityError(null);
      } catch {
        if (cancelled) return;
        hasProcessedRemoteClipboardRef.current = true;
        setClipboardSecurityError("Clipboard encryption failed");
        setRemoteClipboardPayload(null);
      }
    };

    void syncRemoteClipboard();

    return () => {
      cancelled = true;
    };
  }, [clipboardText, getClipboardCryptoKey, state]);

  // Keep current auto local clipboard sync behavior.
  useEffect(() => {
    if (clipboardText === lastSyncedRemoteClipboardRef.current) return;
    lastSyncedRemoteClipboardRef.current = clipboardText;
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(clipboardText).catch(() => {
      // Silent fallback when Clipboard API write is unavailable or blocked.
    });
  }, [clipboardText]);

  // Update document title based on connection state.
  useEffect(() => {
    if (state === "connected" && connectionTarget) {
      document.title = `${connectionTarget.vncHost}:${connectionTarget.vncPort} — guac-vnc`;
    } else {
      document.title = "guac-vnc";
    }
  }, [state, connectionTarget]);

  // Focus hidden input once connected, reset clipboard state on disconnect.
  useEffect(() => {
    if (state === "connected") {
      hiddenInputRef.current?.focus();
    } else {
      setIsDisplayFocused(false);
      setIsManualClipboardInputActive(false);
    }
    if (state === "idle" || state === "disconnected") {
      setRemoteClipboardPayload(null);
      setClipboardSecurityError(null);
      hasProcessedRemoteClipboardRef.current = false;
      clipboardCryptoKeyRef.current = null;
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

  const showClipboardNotice = useCallback((message: string) => {
    setClipboardSendNotice(message);
    if (clipboardSendNoticeTimerRef.current) {
      clearTimeout(clipboardSendNoticeTimerRef.current);
    }
    clipboardSendNoticeTimerRef.current = setTimeout(() => {
      setClipboardSendNotice(null);
      clipboardSendNoticeTimerRef.current = null;
    }, CLIPBOARD_NOTICE_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (clipboardSendNoticeTimerRef.current) {
        clearTimeout(clipboardSendNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (toolbarOpen) return;
    setClipboardInput("");
    setIsManualClipboardInputActive(false);
  }, [toolbarOpen]);

  const isRemoteMetadataMode =
    !!remoteClipboardPayload && !isManualClipboardInputActive;
  const clipboardMetadataLines = useMemo(() => {
    if (!remoteClipboardPayload) return [] as string[];
    const receivedAt = new Date(
      remoteClipboardPayload.receivedAtMs,
    ).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
    return [
      `CRC32 ${remoteClipboardPayload.checksumCrc32}`,
      `LEN ${remoteClipboardPayload.contentLengthBytes}B`,
      `AT ${receivedAt}`,
    ];
  }, [remoteClipboardPayload]);
  const clipboardMetadataText = useMemo(() => {
    return clipboardMetadataLines.join("\n");
  }, [clipboardMetadataLines]);
  const displayedClipboardText = useMemo(() => {
    if (isRemoteMetadataMode) return clipboardMetadataText;
    return clipboardInput;
  }, [clipboardInput, clipboardMetadataText, isRemoteMetadataMode]);

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

  const fabWidth = isCoarsePointer ? FAB_COMBO_WIDTH : FAB_SIZE;

  const clampFabPosition = useCallback(
    (x: number, y: number): FabPosition => {
      const minX = viewportState.offsetX + FAB_MARGIN;
      const minY = viewportState.offsetY + FAB_MARGIN;
      const maxX =
        viewportState.offsetX +
        Math.max(FAB_MARGIN, viewportState.width - fabWidth - FAB_MARGIN);
      const bottomInset = softKeyboardOpen ? SOFT_KEYBOARD_HEIGHT : 0;
      const maxY =
        viewportState.offsetY +
        Math.max(
          FAB_MARGIN,
          viewportState.height - FAB_SIZE - FAB_MARGIN - bottomInset,
        );

      return {
        x: Math.min(Math.max(x, minX), maxX),
        y: Math.min(Math.max(y, minY), maxY),
      };
    },
    [viewportState, fabWidth, softKeyboardOpen],
  );

  const getDefaultFabPosition = useCallback((): FabPosition => {
    return clampFabPosition(
      viewportState.offsetX + viewportState.width - fabWidth - FAB_MARGIN,
      viewportState.offsetY + FAB_MARGIN,
    );
  }, [clampFabPosition, viewportState, fabWidth]);

  const handleFabPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
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
    (e: React.PointerEvent<HTMLDivElement>) => {
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
    if (dragState.dragged) {
      // On touch devices the browser may not fire a click event after a drag,
      // leaving suppressFabClickRef stuck. Clear it after a short delay so the
      // next tap isn't swallowed.
      setTimeout(() => {
        suppressFabClickRef.current = false;
      }, 400);
    }
  }, []);

  const handleFabPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      endFabDrag(e.pointerId);
    },
    [endFabDrag],
  );

  const handleFabPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      endFabDrag(e.pointerId);
    },
    [endFabDrag],
  );

  const handleFabClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressFabClickRef.current) {
        suppressFabClickRef.current = false;
        return;
      }
      if (isCoarsePointer && !toolbarOpen) {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        if (clickX < rect.width / 2) {
          setSoftKeyboardOpen((prev) => !prev);
        } else {
          toggleToolbar();
        }
      } else {
        toggleToolbar();
      }
    },
    [isCoarsePointer, toolbarOpen, toggleToolbar],
  );

  const handleDisplayFocus = useCallback(() => {
    setIsDisplayFocused(true);
  }, []);

  const handleDisplayBlur = useCallback(() => {
    setIsDisplayFocused(false);
  }, []);

  const handleDisplayPointerDown = useCallback(() => {
    // Focus the container (not the hidden input) so keyboard events are
    // captured without triggering the mobile soft keyboard on every tap/pan.
    containerRef.current?.focus();
  }, []);

  const handleDisplayKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (state !== "connected" || !isDisplayFocused) return;
      if (e.repeat || e.altKey || e.shiftKey) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "v") return;

      e.preventDefault();
      e.stopPropagation();

      void (async () => {
        const text = await readLocalClipboardText();
        if (text !== null) {
          setClipboardInput(text);
          setIsManualClipboardInputActive(true);
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

  const decryptCurrentRemoteClipboard = useCallback(async (): Promise<
    string | null
  > => {
    if (!remoteClipboardPayload) return null;
    try {
      return await decryptRemoteClipboardPayload(remoteClipboardPayload);
    } catch {
      setClipboardSecurityError("Clipboard decryption failed");
      return null;
    }
  }, [decryptRemoteClipboardPayload, remoteClipboardPayload]);

  const handleRevealRemoteClipboard = useCallback(() => {
    void (async () => {
      const plaintext = await decryptCurrentRemoteClipboard();
      if (plaintext === null) return;
      setClipboardInput(plaintext);
      setIsManualClipboardInputActive(true);
      setClipboardSecurityError(null);
    })();
  }, [decryptCurrentRemoteClipboard]);

  const handleClipboardInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setClipboardInput(e.currentTarget.value);
      setIsManualClipboardInputActive(true);
    },
    [],
  );

  const handlePasteClipboard = useCallback(() => {
    const sent = sendClipboard(clipboardInput);
    if (!sent) {
      showClipboardNotice("Clipboard send failed");
      return;
    }
    setToolbarOpen(false);
    showClipboardNotice("Clipboard sent to remote");
  }, [clipboardInput, sendClipboard, showClipboardNotice]);

  const selectClipboardText = useCallback((target: HTMLTextAreaElement) => {
    target.focus();
    target.select();
    target.setSelectionRange(0, target.value.length);
  }, []);

  const handleClipboardFocus = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      if (isRemoteMetadataMode) return;
      selectClipboardText(e.currentTarget);
    },
    [isRemoteMetadataMode, selectClipboardText],
  );

  const handleClipboardClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      if (isRemoteMetadataMode) return;
      selectClipboardText(e.currentTarget);
    },
    [isRemoteMetadataMode, selectClipboardText],
  );

  const handleCopyClipboard = useCallback(async () => {
    let text = clipboardInput;
    if (isRemoteMetadataMode) {
      const plaintext = await decryptCurrentRemoteClipboard();
      if (plaintext === null) return;
      text = plaintext;
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
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
  }, [
    clipboardInput,
    decryptCurrentRemoteClipboard,
    isRemoteMetadataMode,
    selectClipboardText,
  ]);

  const handleShowKeyboard = useCallback(() => {
    setSoftKeyboardOpen(false);
    hiddenInputRef.current?.focus();
    setToolbarOpen(false);
  }, []);

  const handleToggleSoftKeyboard = useCallback(() => {
    setSoftKeyboardOpen((prev) => !prev);
    setToolbarOpen(false);
  }, []);

  const handleTakeOverSession = useCallback(() => {
    disconnect();
    void (async () => {
      try {
        const res = await fetch("/api/app/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        if (res.status === 401) {
          setAuthState("unauthenticated");
          return;
        }
        if (res.ok) {
          const { sessionId } = (await res.json()) as { sessionId: string };
          sessionIdRef.current = sessionId;
        } else {
          console.error("Session takeover failed:", res.status);
          sessionIdRef.current = null;
        }
      } catch (err) {
        console.error("Session takeover error:", err);
        sessionIdRef.current = null;
      }
      setSessionPhase("ready");
    })();
  }, [disconnect]);

  const handleLogout = useCallback(() => {
    disconnect();
    setToolbarOpen(false);
    setSessionPhase("checking");
    void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      setAuthState("unauthenticated");
    });
  }, [disconnect]);

  const handleLogin = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (loginLoading) return;
      setLoginLoading(true);
      setLoginError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: loginUsername,
            password: loginPassword,
          }),
        });
        if (res.ok) {
          setLoginUsername("");
          setLoginPassword("");
          setAuthState("authenticated");
        } else {
          setLoginError("Invalid credentials");
        }
      } catch {
        setLoginError("Network error");
      } finally {
        setLoginLoading(false);
      }
    },
    [loginUsername, loginPassword, loginLoading],
  );

  const handleConnect = useCallback(() => {
    disconnect();
    connect({
      sessionId: sessionIdRef.current ?? undefined,
    });
  }, [disconnect, connect]);

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
      Math.max(
        FAB_MARGIN,
        viewportState.width - TOOLBAR_RENDERED_WIDTH - FAB_MARGIN,
      );
    const desiredLeft =
      resolvedFabPosition.x + FAB_SIZE - TOOLBAR_RENDERED_WIDTH;
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
    <div className={`app ${softKeyboardOpen ? "soft-keyboard-active" : ""}`}>
      <div
        ref={containerRef}
        className="display-container"
        role="application"
        aria-label="Remote display"
        tabIndex={-1}
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

      {/* Login overlay */}
      {authState !== "authenticated" && (
        <div className="overlay">
          {authState === "checking" && (
            <div className="status">
              <h1>guac-vnc</h1>
              <p>Checking authentication...</p>
            </div>
          )}
          {authState === "unauthenticated" && (
            <div className="status">
              <h1>guac-vnc</h1>
              <p>Login required</p>
              {loginError && <p>Error: {loginError}</p>}
              <form onSubmit={handleLogin}>
                <label
                  htmlFor="login-username"
                  className="connect-password-label"
                >
                  Username
                </label>
                <input
                  id="login-username"
                  type="text"
                  className="connect-password-input"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="off"
                  disabled={loginLoading}
                />
                <label
                  htmlFor="login-password"
                  className="connect-password-label"
                >
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  className="connect-password-input"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={loginLoading}
                />
                <button type="submit" className="btn" disabled={loginLoading}>
                  {loginLoading ? "Logging in..." : "Login"}
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Connection overlay */}
      {authState === "authenticated" &&
        (sessionPhase !== "ready" || state !== "connected") && (
          <div className="overlay">
            {sessionPhase === "checking" && (
              <div className="status">
                <h1>guac-vnc</h1>
                <p>Checking session...</p>
              </div>
            )}
            {sessionPhase === "prompt" && (
              <div className="status">
                <h1>guac-vnc</h1>
                <p>There is an active session.</p>
                <p>Continuing will disconnect it.</p>
                <button
                  type="button"
                  className="btn"
                  onClick={handleTakeOverSession}
                >
                  Continue
                </button>
              </div>
            )}
            {sessionPhase === "ready" && state === "connecting" && (
              <div className="status">
                <h1>guac-vnc</h1>
                <p>Connecting...</p>
                <p>
                  {connectionTarget
                    ? `Target: ${connectionTarget.vncHost}:${connectionTarget.vncPort}`
                    : connectionTargetError || "Target: loading..."}
                </p>
              </div>
            )}
            {sessionPhase === "ready" && state !== "connecting" && (
              <div className="status">
                <h1>guac-vnc</h1>
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
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-only to avoid key interference
        // biome-ignore lint/a11y/noStaticElementInteractions: click-only FAB with drag
        <div
          className={`fab ${toolbarOpen ? "fab-active" : ""} ${fabDragging ? "fab-dragging" : ""}${isCoarsePointer && !toolbarOpen ? " fab-combo" : ""}`}
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
        >
          {toolbarOpen ? (
            "\u2715"
          ) : isCoarsePointer ? (
            <>
              <span className="fab-combo-half">{"\u2328"}</span>
              <span className="fab-combo-divider" />
              <span className="fab-combo-half">{"\u2630"}</span>
            </>
          ) : (
            "\u2630"
          )}
        </div>
      )}

      {/* Toolbar drawer */}
      {toolbarOpen && (
        <div className="toolbar" style={toolbarStyle}>
          <div className="toolbar-section">
            {isRemoteMetadataMode ? (
              <span className="toolbar-label">Clipboard</span>
            ) : (
              <label className="toolbar-label" htmlFor="clipboard-input">
                Clipboard
              </label>
            )}
            <div className="clipboard-input-shell">
              {isRemoteMetadataMode ? (
                <button
                  type="button"
                  className="clipboard-metadata-card"
                  onClick={handleRevealRemoteClipboard}
                  aria-label="Reveal encrypted clipboard content"
                >
                  {clipboardMetadataLines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static display list
                    <span key={index} className="clipboard-metadata-primary">
                      {line}
                    </span>
                  ))}
                  <span className="clipboard-metadata-secondary">
                    Click anywhere to reveal
                  </span>
                </button>
              ) : (
                <textarea
                  id="clipboard-input"
                  ref={clipboardInputRef}
                  className="clipboard-input"
                  value={displayedClipboardText}
                  onChange={handleClipboardInputChange}
                  onFocus={handleClipboardFocus}
                  onClick={handleClipboardClick}
                  rows={6}
                />
              )}
            </div>
            {clipboardSecurityError && (
              <p className="clipboard-security-error">
                {clipboardSecurityError}
              </p>
            )}
            <div className="clipboard-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={handlePasteClipboard}
                disabled={isRemoteMetadataMode}
              >
                Send
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleCopyClipboard}
              >
                Copy
              </button>
            </div>
            <div className="toolbar-browser-shortcuts">
              <span className="toolbar-browser-shortcuts-label">
                Special keys
              </span>
              <div className="toolbar-browser-shortcuts-keys">
                {DESKTOP_BROWSER_BLOCKED_KEYS.map((shortcut) => (
                  <button
                    key={shortcut.label}
                    type="button"
                    className="btn btn-xs"
                    onClick={() => sendKeyCombo([...shortcut.keysyms])}
                    title={`Send ${shortcut.label} to remote`}
                  >
                    {shortcut.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="toolbar-section toolbar-buttons">
            <button
              type="button"
              className="btn btn-sm btn-help"
              onClick={() => setShowGestureHelp(true)}
            >
              ?
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleToggleSoftKeyboard}
            >
              Soft Keys
            </button>
            {showKeyboardShortcut && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleShowKeyboard}
              >
                Keyboard
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-danger btn-disconnect"
              onClick={handleLogout}
              title="Disconnect"
            >
              <svg
                className="disconnect-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Disconnect"
              >
                <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
              <span className="disconnect-label">Disconnect</span>
            </button>
          </div>
        </div>
      )}

      {/* Soft keyboard panel */}
      {softKeyboardOpen && state === "connected" && (
        <SoftKeyboardPanel
          sendKey={sendKey}
          sendKeyCombo={sendKeyCombo}
          onClose={() => setSoftKeyboardOpen(false)}
        />
      )}

      {/* Gesture help overlay */}
      {showGestureHelp && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: tap-outside dismiss
        // biome-ignore lint/a11y/noStaticElementInteractions: overlay backdrop
        <div
          className="gesture-help-overlay"
          onClick={() => setShowGestureHelp(false)}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner card */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: inner card */}
          <div
            className="gesture-help-content"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="gesture-help-title">Touch Gestures</h2>
            <dl className="gesture-help-list">
              <div className="gesture-help-item">
                <dt>Tap</dt>
                <dd>Left-click</dd>
              </div>
              <div className="gesture-help-item">
                <dt>Double-tap and drag</dt>
                <dd>Tap once, tap again and hold to grab, then drag</dd>
              </div>
              <div className="gesture-help-item">
                <dt>One-finger drag</dt>
                <dd>Move cursor + pan</dd>
              </div>
              <div className="gesture-help-item">
                <dt>Two-finger tap</dt>
                <dd>Right-click</dd>
              </div>
              <div className="gesture-help-item">
                <dt>Two-finger pinch</dt>
                <dd>Zoom</dd>
              </div>
              <div className="gesture-help-item">
                <dt>Three-finger swipe</dt>
                <dd>Scroll</dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowGestureHelp(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {clipboardSendNotice && (
        <output className="clipboard-notice" aria-live="polite">
          {clipboardSendNotice}
        </output>
      )}
    </div>
  );
}
