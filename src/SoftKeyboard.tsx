import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PrintableSoftKey,
  SoftKeyboardScreen,
  SoftKeyDefinition,
  SoftKeyModifiers,
  SpecialSoftKey,
} from "./softKeyboard";
import {
  FUNCTION_KEY_ROW,
  GUI_COMBO_ROW,
  MODIFIER_KEYSYMS,
  PRIMARY_SCREEN_ROWS,
  SECONDARY_SCREEN_ROWS,
} from "./softKeyboard";

// ── Constants ──

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 80;

const MODIFIER_LABELS: Record<keyof SoftKeyModifiers, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  super: "Super",
};

// Keys that should toggle sticky modifiers rather than repeat
const MODIFIER_KEY_LABELS = new Set(["Shift", "Ctrl", "Alt", "Super"]);

// ── Props ──

interface SoftKeyboardPanelProps {
  sendKey: (keysym: number, pressed: boolean) => void;
  sendKeyCombo: (keysyms: number[]) => void;
  onClose: () => void;
}

// ── Helpers ──

function isModifierKey(def: SoftKeyDefinition): keyof SoftKeyModifiers | null {
  if (def.type !== "special") return null;
  for (const [mod, keysym] of Object.entries(MODIFIER_KEYSYMS)) {
    if (def.keysym === keysym && MODIFIER_KEY_LABELS.has(def.label)) {
      return mod as keyof SoftKeyModifiers;
    }
  }
  return null;
}

function getDisplayLabel(def: SoftKeyDefinition, shift: boolean): string {
  if (def.type === "printable" && shift) {
    return def.shiftLabel ?? def.label.toUpperCase();
  }
  return def.label;
}

// ── SoftKeyButton ──

interface SoftKeyButtonProps {
  def: SoftKeyDefinition;
  modifiers: SoftKeyModifiers;
  onPress: (def: SoftKeyDefinition) => void;
  onRelease: (def: SoftKeyDefinition) => void;
  isActive?: boolean;
  scrollable?: boolean;
}

function SoftKeyButton({
  def,
  modifiers,
  onPress,
  onRelease,
  isActive,
  scrollable,
}: SoftKeyButtonProps) {
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pressedRef = useRef(false);

  const clearRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => clearRepeat, [clearRepeat]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      pressedRef.current = true;
      onPress(def);

      // No repeat for modifiers or combos
      if (isModifierKey(def) || def.type === "combo") return;

      clearRepeat();
      repeatTimerRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          onPress(def);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    [def, onPress, clearRepeat],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (!pressedRef.current) return;
      pressedRef.current = false;
      clearRepeat();
      onRelease(def);
    },
    [def, onRelease, clearRepeat],
  );

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (!pressedRef.current) return;
      pressedRef.current = false;
      clearRepeat();
      onRelease(def);
    },
    [def, onRelease, clearRepeat],
  );

  const label = getDisplayLabel(def, modifiers.shift);
  const isSingleChar = label.length === 1;
  const widthClass = def.width
    ? `sk-wide-${String(def.width).replace(".", "_")}`
    : "";
  const showShiftHint =
    def.type === "printable" &&
    !modifiers.shift &&
    def.shiftLabel &&
    def.shiftLabel !== def.label.toUpperCase();

  return (
    <div
      className={`sk-button ${widthClass} ${isActive ? "sk-active" : ""} ${isSingleChar ? "sk-single-char" : ""}`}
      {...(scrollable
        ? { onClick: () => onPress(def) }
        : {
            onPointerDown: handlePointerDown,
            onPointerUp: handlePointerUp,
            onPointerLeave: handlePointerLeave,
            onPointerCancel: handlePointerLeave,
          })}
    >
      {label}
      {showShiftHint && (
        <span className="sk-shift-hint">
          {(def as PrintableSoftKey).shiftLabel}
        </span>
      )}
    </div>
  );
}

// ── SoftKeyboardPanel ──

export function SoftKeyboardPanel({
  sendKey,
  sendKeyCombo,
  onClose,
}: SoftKeyboardPanelProps) {
  const [modifiers, setModifiers] = useState<SoftKeyModifiers>({
    ctrl: false,
    alt: false,
    shift: false,
    super: false,
  });
  const [screen, setScreen] = useState<SoftKeyboardScreen>("primary");

  // ── Drag state (desktop floating mode) ──
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [dragPosition, setDragPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setDragPosition({ left: rect.left, top: rect.top });
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      const left = Math.max(
        0,
        Math.min(e.clientX - drag.offsetX, window.innerWidth - 100),
      );
      const top = Math.max(
        0,
        Math.min(e.clientY - drag.offsetY, window.innerHeight - 100),
      );
      setDragPosition({ left, top });
    };
    const stopDrag = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
    };
    window.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, []);

  const fireKeyWithModifiers = useCallback(
    (keysym: number) => {
      const activeModKeysyms: number[] = [];
      for (const [mod, active] of Object.entries(modifiers)) {
        if (active) {
          activeModKeysyms.push(
            MODIFIER_KEYSYMS[mod as keyof SoftKeyModifiers],
          );
        }
      }

      if (activeModKeysyms.length > 0) {
        // Press modifiers down, press key, release key, release modifiers, clear
        for (const mk of activeModKeysyms) sendKey(mk, true);
        sendKey(keysym, true);
        sendKey(keysym, false);
        for (const mk of activeModKeysyms.reverse()) sendKey(mk, false);
        setModifiers({ ctrl: false, alt: false, shift: false, super: false });
      } else {
        sendKey(keysym, true);
        sendKey(keysym, false);
      }
    },
    [modifiers, sendKey],
  );

  const handleKeyPress = useCallback(
    (def: SoftKeyDefinition) => {
      // Modifier toggle
      const mod = isModifierKey(def);
      if (mod) {
        setModifiers((prev) => ({ ...prev, [mod]: !prev[mod] }));
        return;
      }

      if (def.type === "combo") {
        sendKeyCombo(def.keysyms);
        return;
      }

      if (def.type === "printable") {
        const keysym = modifiers.shift ? def.shiftKeysym : def.keysym;
        fireKeyWithModifiers(keysym);
        return;
      }

      // Special (non-modifier)
      fireKeyWithModifiers((def as SpecialSoftKey).keysym);
    },
    [modifiers.shift, fireKeyWithModifiers, sendKeyCombo],
  );

  const handleKeyRelease = useCallback((_def: SoftKeyDefinition) => {
    // Release is handled inline — nothing to do here.
    // Key repeat fires handleKeyPress repeatedly; pointer-up stops repeat.
  }, []);

  const topRow = screen === "primary" ? GUI_COMBO_ROW : FUNCTION_KEY_ROW;
  const mainRows =
    screen === "primary" ? PRIMARY_SCREEN_ROWS : SECONDARY_SCREEN_ROWS;

  const panelStyle = dragPosition
    ? {
        left: `${dragPosition.left}px`,
        top: `${dragPosition.top}px`,
        right: "auto",
        bottom: "auto",
      }
    : undefined;

  return (
    <div className="sk-panel" ref={panelRef} style={panelStyle}>
      {/* Desktop drag bar + close */}
      <div className="sk-toolbar">
        <div className="sk-toolbar-spacer" />
        <button
          type="button"
          className="sk-drag-handle"
          aria-label="Drag soft keyboard"
          onPointerDown={handleDragStart}
        >
          ⠿
        </button>
        <button
          type="button"
          className="sk-toolbar-close"
          aria-label="Close soft keyboard"
          onClick={() => {
            if (!dragRef.current) onClose();
          }}
        >
          ✕
        </button>
      </div>

      {/* Top scrollable row */}
      <div className={screen === "primary" ? "sk-combo-row" : "sk-fkey-row"}>
        {topRow.map((def) => (
          <SoftKeyButton
            key={def.label}
            def={def}
            modifiers={modifiers}
            onPress={handleKeyPress}
            onRelease={handleKeyRelease}
            scrollable
          />
        ))}
      </div>

      {/* Main rows */}
      <div className="sk-grid">
        {mainRows.map((row, rowIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable row order
          <div key={rowIndex} className="sk-row">
            {row.map((def) => (
              <SoftKeyButton
                key={def.label}
                def={def}
                modifiers={modifiers}
                onPress={handleKeyPress}
                onRelease={handleKeyRelease}
                isActive={
                  isModifierKey(def)
                    ? modifiers[isModifierKey(def) as keyof SoftKeyModifiers]
                    : false
                }
              />
            ))}
          </div>
        ))}
      </div>

      {/* Screen toggle + modifier indicators */}
      <div className="sk-status-row">
        <button
          type="button"
          className="sk-screen-toggle"
          onClick={() =>
            setScreen(screen === "primary" ? "secondary" : "primary")
          }
        >
          {screen === "primary" ? "Sym/Nav" : "ABC"}
        </button>
        <div className="sk-modifier-indicators">
          {(Object.keys(modifiers) as (keyof SoftKeyModifiers)[]).map(
            (mod) =>
              modifiers[mod] && (
                <span key={mod} className="sk-modifier-badge">
                  {MODIFIER_LABELS[mod]}
                </span>
              ),
          )}
        </div>
      </div>
    </div>
  );
}
