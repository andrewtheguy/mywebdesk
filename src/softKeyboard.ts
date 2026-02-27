// ── Types ──

export interface PrintableSoftKey {
  type: "printable";
  label: string;
  keysym: number;
  shiftKeysym: number;
  shiftLabel?: string;
  width?: number;
}

export interface SpecialSoftKey {
  type: "special";
  label: string;
  keysym: number;
  width?: number;
}

export interface ComboSoftKey {
  type: "combo";
  label: string;
  keysyms: number[];
  width?: number;
}

export type SoftKeyDefinition =
  | PrintableSoftKey
  | SpecialSoftKey
  | ComboSoftKey;

export interface SoftKeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
}

export type SoftKeyboardScreen = "primary" | "secondary";

// ── X11 keysyms ──

const XK_Escape = 0xff1b;
const XK_Tab = 0xff09;
const XK_BackSpace = 0xff08;
const XK_Return = 0xff0d;
const XK_Delete = 0xffff;
const XK_Insert = 0xff63;
const XK_Home = 0xff50;
const XK_End = 0xff57;
const XK_Page_Up = 0xff55;
const XK_Page_Down = 0xff56;
const XK_Left = 0xff51;
const XK_Up = 0xff52;
const XK_Right = 0xff53;
const XK_Down = 0xff54;
const XK_space = 0x0020;
const XK_Control_L = 0xffe3;
const XK_Alt_L = 0xffe9;
const XK_Shift_L = 0xffe1;
const XK_Super_L = 0xffeb;

const XK_F1 = 0xffbe;
const XK_F2 = 0xffbf;
const XK_F3 = 0xffc0;
const XK_F4 = 0xffc1;
const XK_F5 = 0xffc2;
const XK_F6 = 0xffc3;
const XK_F7 = 0xffc4;
const XK_F8 = 0xffc5;
const XK_F9 = 0xffc6;
const XK_F10 = 0xffc7;
const XK_F11 = 0xffc8;
const XK_F12 = 0xffc9;

// Printable keysyms (lowercase / uppercase or unshifted / shifted)
function p(
  label: string,
  keysym: number,
  shiftKeysym: number,
  shiftLabel?: string,
  width?: number,
): PrintableSoftKey {
  return { type: "printable", label, keysym, shiftKeysym, shiftLabel, width };
}

function s(label: string, keysym: number, width?: number): SpecialSoftKey {
  return { type: "special", label, keysym, width };
}

function c(label: string, keysyms: number[], width?: number): ComboSoftKey {
  return { type: "combo", label, keysyms, width };
}

// ── GUI combo row (scrollable quick-access) ──

export const GUI_COMBO_ROW: SoftKeyDefinition[] = [
  s("Esc", XK_Escape),
  c("Alt+Tab", [XK_Alt_L, XK_Tab]),
  c("Alt+F4", [XK_Alt_L, XK_F4]),
  c("C+A+Del", [XK_Control_L, XK_Alt_L, XK_Delete]),
  s("Win", XK_Super_L),
  c("Ctrl+Esc", [XK_Control_L, XK_Escape]),
  c("Ctrl+Z", [XK_Control_L, 0x007a]),
  c("Ctrl+C", [XK_Control_L, 0x0063]),
  c("Ctrl+V", [XK_Control_L, 0x0076]),
  c("Ctrl+A", [XK_Control_L, 0x0061]),
  c("Ctrl+S", [XK_Control_L, 0x0073]),
];

// ── Primary screen: QWERTY ──

const ROW_DIGITS: SoftKeyDefinition[] = [
  p("1", 0x0031, 0x0021, "!"),
  p("2", 0x0032, 0x0040, "@"),
  p("3", 0x0033, 0x0023, "#"),
  p("4", 0x0034, 0x0024, "$"),
  p("5", 0x0035, 0x0025, "%"),
  p("6", 0x0036, 0x005e, "^"),
  p("7", 0x0037, 0x0026, "&"),
  p("8", 0x0038, 0x002a, "*"),
  p("9", 0x0039, 0x0028, "("),
  p("0", 0x0030, 0x0029, ")"),
];

const ROW_QWERTY: SoftKeyDefinition[] = [
  p("q", 0x0071, 0x0051),
  p("w", 0x0077, 0x0057),
  p("e", 0x0065, 0x0045),
  p("r", 0x0072, 0x0052),
  p("t", 0x0074, 0x0054),
  p("y", 0x0079, 0x0059),
  p("u", 0x0075, 0x0055),
  p("i", 0x0069, 0x0049),
  p("o", 0x006f, 0x004f),
  p("p", 0x0070, 0x0050),
];

const ROW_HOME: SoftKeyDefinition[] = [
  p("a", 0x0061, 0x0041),
  p("s", 0x0073, 0x0053),
  p("d", 0x0064, 0x0044),
  p("f", 0x0066, 0x0046),
  p("g", 0x0067, 0x0047),
  p("h", 0x0068, 0x0048),
  p("j", 0x006a, 0x004a),
  p("k", 0x006b, 0x004b),
  p("l", 0x006c, 0x004c),
];

const ROW_ZXCV: SoftKeyDefinition[] = [
  s("Shift", XK_Shift_L, 1.5),
  p("z", 0x007a, 0x005a),
  p("x", 0x0078, 0x0058),
  p("c", 0x0063, 0x0043),
  p("v", 0x0076, 0x0056),
  p("b", 0x0062, 0x0042),
  p("n", 0x006e, 0x004e),
  p("m", 0x006d, 0x004d),
  s("Bksp", XK_BackSpace, 1.5),
];

const ROW_BOTTOM: SoftKeyDefinition[] = [
  s("Tab", XK_Tab, 1.3),
  s("Ctrl", XK_Control_L, 1.3),
  s("Alt", XK_Alt_L, 1.3),
  s("Super", XK_Super_L),
  s("Space", XK_space, 2.5),
  s("Enter", XK_Return, 1.6),
];

export const PRIMARY_SCREEN_ROWS: SoftKeyDefinition[][] = [
  ROW_DIGITS,
  ROW_QWERTY,
  ROW_HOME,
  ROW_ZXCV,
  ROW_BOTTOM,
];

// ── Secondary screen: symbols + navigation ──

const ROW_SYMBOLS_1: SoftKeyDefinition[] = [
  p("`", 0x0060, 0x007e, "~"),
  p("-", 0x002d, 0x005f, "_"),
  p("=", 0x003d, 0x002b, "+"),
  p("[", 0x005b, 0x007b, "{"),
  p("]", 0x005d, 0x007d, "}"),
  p("\\", 0x005c, 0x007c, "|"),
  p(";", 0x003b, 0x003a, ":"),
  p("'", 0x0027, 0x0022, '"'),
  p(",", 0x002c, 0x003c, "<"),
  p(".", 0x002e, 0x003e, ">"),
];

const ROW_SYMBOLS_2: SoftKeyDefinition[] = [
  p("/", 0x002f, 0x003f, "?"),
  s("Ins", XK_Insert),
  s("Del", XK_Delete),
  s("Home", XK_Home),
  s("End", XK_End),
  s("PgUp", XK_Page_Up),
  s("PgDn", XK_Page_Down),
];

const ROW_NAV_ARROWS: SoftKeyDefinition[] = [
  s("Left", XK_Left, 1.5), // ←
  s("Up", XK_Up, 1.5), // ↑
  s("Down", XK_Down, 1.5), // ↓
  s("Right", XK_Right, 1.5), // →
];

const ROW_NAV_BOTTOM: SoftKeyDefinition[] = [
  s("Tab", XK_Tab, 1.3),
  s("Ctrl", XK_Control_L, 1.3),
  s("Alt", XK_Alt_L, 1.3),
  s("Super", XK_Super_L),
  s("Space", XK_space, 2.5),
  s("Enter", XK_Return, 1.6),
];

export const SECONDARY_SCREEN_ROWS: SoftKeyDefinition[][] = [
  ROW_SYMBOLS_1,
  ROW_SYMBOLS_2,
  ROW_NAV_ARROWS,
  ROW_NAV_BOTTOM,
];

// ── Function key row ──

export const FUNCTION_KEY_ROW: SoftKeyDefinition[] = [
  s("F1", XK_F1),
  s("F2", XK_F2),
  s("F3", XK_F3),
  s("F4", XK_F4),
  s("F5", XK_F5),
  s("F6", XK_F6),
  s("F7", XK_F7),
  s("F8", XK_F8),
  s("F9", XK_F9),
  s("F10", XK_F10),
  s("F11", XK_F11),
  s("F12", XK_F12),
];

// ── Modifier keysym constants (exported for use in SoftKeyboard.tsx) ──

export const MODIFIER_KEYSYMS = {
  ctrl: XK_Control_L,
  alt: XK_Alt_L,
  shift: XK_Shift_L,
  super: XK_Super_L,
} as const;

// ── Desktop PC keyboard layout ──

export const DESKTOP_FUNCTION_ROW: SoftKeyDefinition[] = [
  s("Esc", XK_Escape),
  s("F1", XK_F1),
  s("F2", XK_F2),
  s("F3", XK_F3),
  s("F4", XK_F4),
  s("F5", XK_F5),
  s("F6", XK_F6),
  s("F7", XK_F7),
  s("F8", XK_F8),
  s("F9", XK_F9),
  s("F10", XK_F10),
  s("F11", XK_F11),
  s("F12", XK_F12),
];

export const DESKTOP_NUMBER_ROW: SoftKeyDefinition[] = [
  p("`", 0x0060, 0x007e, "~"),
  p("1", 0x0031, 0x0021, "!"),
  p("2", 0x0032, 0x0040, "@"),
  p("3", 0x0033, 0x0023, "#"),
  p("4", 0x0034, 0x0024, "$"),
  p("5", 0x0035, 0x0025, "%"),
  p("6", 0x0036, 0x005e, "^"),
  p("7", 0x0037, 0x0026, "&"),
  p("8", 0x0038, 0x002a, "*"),
  p("9", 0x0039, 0x0028, "("),
  p("0", 0x0030, 0x0029, ")"),
  p("-", 0x002d, 0x005f, "_"),
  p("=", 0x003d, 0x002b, "+"),
  s("Bksp", XK_BackSpace),
];

export const DESKTOP_QWERTY_ROW: SoftKeyDefinition[] = [
  s("Tab", XK_Tab),
  p("q", 0x0071, 0x0051),
  p("w", 0x0077, 0x0057),
  p("e", 0x0065, 0x0045),
  p("r", 0x0072, 0x0052),
  p("t", 0x0074, 0x0054),
  p("y", 0x0079, 0x0059),
  p("u", 0x0075, 0x0055),
  p("i", 0x0069, 0x0049),
  p("o", 0x006f, 0x004f),
  p("p", 0x0070, 0x0050),
  p("[", 0x005b, 0x007b, "{"),
  p("]", 0x005d, 0x007d, "}"),
  p("\\", 0x005c, 0x007c, "|"),
];

export const DESKTOP_HOME_ROW: SoftKeyDefinition[] = [
  p("a", 0x0061, 0x0041),
  p("s", 0x0073, 0x0053),
  p("d", 0x0064, 0x0044),
  p("f", 0x0066, 0x0046),
  p("g", 0x0067, 0x0047),
  p("h", 0x0068, 0x0048),
  p("j", 0x006a, 0x004a),
  p("k", 0x006b, 0x004b),
  p("l", 0x006c, 0x004c),
  p(";", 0x003b, 0x003a, ":"),
  p("'", 0x0027, 0x0022, '"'),
  s("Enter", XK_Return),
];

export const DESKTOP_ZXCV_ROW: SoftKeyDefinition[] = [
  p("z", 0x007a, 0x005a),
  p("x", 0x0078, 0x0058),
  p("c", 0x0063, 0x0043),
  p("v", 0x0076, 0x0056),
  p("b", 0x0062, 0x0042),
  p("n", 0x006e, 0x004e),
  p("m", 0x006d, 0x004d),
  p(",", 0x002c, 0x003c, "<"),
  p(".", 0x002e, 0x003e, ">"),
  p("/", 0x002f, 0x003f, "?"),
];

export const DESKTOP_SPACE_KEY: SoftKeyDefinition = s("Space", XK_space);

export const DESKTOP_NAV_ROW_1: SoftKeyDefinition[] = [
  s("Ins", XK_Insert),
  s("Home", XK_Home),
  s("PgUp", XK_Page_Up),
];

export const DESKTOP_NAV_ROW_2: SoftKeyDefinition[] = [
  s("Del", XK_Delete),
  s("End", XK_End),
  s("PgDn", XK_Page_Down),
];

export const DESKTOP_ARROW_ROW_1: SoftKeyDefinition[] = [s("▲", XK_Up)];

export const DESKTOP_ARROW_ROW_2: SoftKeyDefinition[] = [
  s("◀", XK_Left),
  s("▼", XK_Down),
  s("▶", XK_Right),
];
