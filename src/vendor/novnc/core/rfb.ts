/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2020 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

import CopyRectDecoder from "./decoders/copyrect";
import RawDecoder from "./decoders/raw";
import TightDecoder from "./decoders/tight";
import Deflator from "./deflator";
import Display from "./display";
import { encodings } from "./encodings";
import Inflator from "./inflator";
import XtScancode from "./input/xtscancodes";
import { toSigned32bit, toUnsigned32bit } from "./util/int";
import * as Log from "./util/logging";
import { decodeUTF8, encodeUTF8 } from "./util/strings";
import Websock from "./websock";

// How many seconds to wait for a disconnect to finish
const DISCONNECT_TIMEOUT = 3;
const DEFAULT_BACKGROUND = "rgb(40, 40, 40)";

// How long the container size must be stable before a remote resize is
// requested. Matches the app's viewport-resize debounce so both request
// paths settle together after the window stops changing size.
const RESIZE_REQUEST_DEBOUNCE_MS = 250;

// Tight encoding quality/compression advertised to the server
const QUALITY_LEVEL = 6;
const COMPRESSION_LEVEL = 2;

// Security types (only None is supported; the proxy in front of this
// client performs the real VNC authentication server-side)
const securityTypeNone = 1;

// Extended clipboard pseudo-encoding formats
const extendedClipboardFormatText = 1;
const _extendedClipboardFormatRtf = 1 << 1;
const _extendedClipboardFormatHtml = 1 << 2;
const _extendedClipboardFormatDib = 1 << 3;
const _extendedClipboardFormatFiles = 1 << 4;

// Extended clipboard pseudo-encoding actions
const extendedClipboardActionCaps = 1 << 24;
const extendedClipboardActionRequest = 1 << 25;
const extendedClipboardActionPeek = 1 << 26;
const extendedClipboardActionNotify = 1 << 27;
const extendedClipboardActionProvide = 1 << 28;

interface FbSize {
  width: number;
  height: number;
}

// The common shape all rect decoders expose; the concrete Raw/CopyRect/Tight
// decoders are structurally compatible (their sock/display params are supersets
// of what Websock/Display provide).
interface Decoder {
  decodeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    sock: Websock,
    display: Display,
    depth: number,
  ): boolean;
}

type ConnectionState =
  | ""
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected";
type InitState =
  | ""
  | "ProtocolVersion"
  | "Security"
  | "Authentication"
  | "SecurityResult"
  | "SecurityReason"
  | "ClientInitialisation"
  | "ServerInitialisation";

export default class RFB extends EventTarget {
  // Public API
  computeTargetSize: (() => FbSize) | null;

  private _target: HTMLElement;
  private _rawChannel: WebSocket | null;

  private _rfbConnectionState: ConnectionState;
  private _rfbInitState: InitState;
  private _rfbAuthScheme: number;
  private _rfbCleanDisconnect: boolean;
  private _rfbVersion: number;
  private _rfbMaxVersion: number;

  private _fbWidth: number;
  private _fbHeight: number;
  private _fbName: string;
  private _fbDepth!: number;

  private _supportsFence: boolean;
  private _supportsContinuousUpdates: boolean;
  private _enabledContinuousUpdates: boolean;
  private _supportsSetDesktopSize: boolean;
  private _screenID: number;
  private _screenFlags: number;
  private _pendingRemoteResize: boolean;
  private _lastResize: number;
  private _qemuExtKeyEventSupported: boolean;

  private _clipboardText: string | null;
  private _clipboardServerCapabilitiesActions: Record<number, boolean>;
  private _clipboardServerCapabilitiesFormats: Record<number, boolean>;

  private _securityContext!: string;
  private _securityStatus!: number;

  private _sock!: Websock;
  private _display!: Display;
  private _flushing: boolean;
  private _resizeObserver!: ResizeObserver;

  private _disconnTimer: ReturnType<typeof setTimeout> | undefined;
  private _resizeTimeout: ReturnType<typeof setTimeout> | undefined;
  private _resizeRequestDebounce: ReturnType<typeof setTimeout> | undefined;

  private _baseScale: number;
  private _decoders: Record<number, Decoder>;

  private _FBU: {
    rects: number;
    x: number;
    y: number;
    width: number;
    height: number;
    encoding: number | null;
  };

  private _screen: HTMLDivElement;
  private _canvas: HTMLCanvasElement;

  private _expectedClientWidth: number | null;
  private _expectedClientHeight: number | null;

  private _resizeSession: boolean;

  constructor(target: HTMLElement, channel: WebSocket) {
    if (!target) {
      throw new Error("Must specify target");
    }
    if (!channel) {
      throw new Error("Must specify WebSocket channel");
    }

    // We rely on modern APIs which might not be available in an
    // insecure context
    if (!window.isSecureContext) {
      Log.ErrorLog("noVNC requires a secure context (TLS). Expect crashes!");
    }

    super();

    this._target = target;
    this._rawChannel = channel;

    // Internal state
    this._rfbConnectionState = "";
    this._rfbInitState = "";
    this._rfbAuthScheme = -1;
    this._rfbCleanDisconnect = true;

    // Server capabilities
    this._rfbVersion = 0;
    this._rfbMaxVersion = 3.8;

    this._fbWidth = 0;
    this._fbHeight = 0;

    this._fbName = "";

    this._supportsFence = false;

    this._supportsContinuousUpdates = false;
    this._enabledContinuousUpdates = false;

    this._supportsSetDesktopSize = false;
    this._screenID = 0;
    this._screenFlags = 0;
    this._pendingRemoteResize = false;
    this._lastResize = 0;

    this._qemuExtKeyEventSupported = false;

    this._clipboardText = null;
    this._clipboardServerCapabilitiesActions = {};
    this._clipboardServerCapabilitiesFormats = {};

    // Internal objects (_sock/_display/_resizeObserver are created below)
    this._flushing = false; // Display flushing state

    // Timers
    this._disconnTimer = undefined; // disconnection timer
    this._resizeTimeout = undefined; // resize rate limiting
    this._resizeRequestDebounce = undefined; // remote-resize debounce

    // Display scale controlled by the app via setBaseScale() (stock
    // noVNC forced 1.0 unless scaleViewport autoscaled to the container)
    this._baseScale = 1;

    // Decoder states
    this._decoders = {};

    this._FBU = {
      rects: 0,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      encoding: null,
    };

    // main setup
    Log.Debug(">> RFB.constructor");

    // Create DOM elements
    this._screen = document.createElement("div");
    this._screen.style.display = "flex";
    this._screen.style.width = "100%";
    this._screen.style.height = "100%";
    this._screen.style.overflow = "auto";
    this._screen.style.background = DEFAULT_BACKGROUND;
    this._canvas = document.createElement("canvas");
    this._canvas.style.margin = "auto";
    this._canvas.width = 0;
    this._canvas.height = 0;
    this._screen.appendChild(this._canvas);

    // populate decoder array with objects. Only the encodings this
    // client advertises (plus Raw, which servers may always use) need
    // decoders; TigerVNC picks Tight.
    this._decoders[encodings.encodingRaw] = new RawDecoder();
    this._decoders[encodings.encodingCopyRect] = new CopyRectDecoder();
    this._decoders[encodings.encodingTight] = new TightDecoder();

    // NB: nothing that needs explicit teardown should be done
    // before this point, since this can throw an exception
    try {
      this._display = new Display(this._canvas);
    } catch (exc) {
      Log.ErrorLog(`Display exception: ${String(exc)}`);
      throw exc;
    }

    this._sock = new Websock();
    this._sock.on("open", this._socketOpen.bind(this));
    this._sock.on("close", this._socketClose.bind(this));
    this._sock.on("message", this._handleMessage.bind(this));
    this._sock.on("error", this._socketError.bind(this));

    this._expectedClientWidth = null;
    this._expectedClientHeight = null;
    this._resizeObserver = new ResizeObserver(this._handleResize.bind(this));

    // All prepared, kick off the connection
    this._updateConnectionState("connecting");

    Log.Debug("<< RFB.constructor");

    // ===== PROPERTIES =====

    // When set, returns the desired framebuffer size in device pixels;
    // it replaces the container CSS size as the setDesktopSize target,
    // making exact HiDPI framebuffer sizing possible.
    this.computeTargetSize = null;

    this._resizeSession = false;
  }

  // ===== PROPERTIES =====

  get resizeSession(): boolean {
    return this._resizeSession;
  }
  set resizeSession(resize: boolean) {
    this._resizeSession = resize;
    if (resize) {
      this._requestRemoteResize();
    }
  }

  // ===== PUBLIC METHODS =====

  disconnect() {
    this._updateConnectionState("disconnecting");
    this._sock.off("error");
    this._sock.off("message");
    this._sock.off("open");
  }

  // Send a key press. If 'down' is not specified then send a down key
  // followed by an up key.
  sendKey(keysym: number | null, code: string | null, down?: boolean): void {
    if (this._rfbConnectionState !== "connected") {
      return;
    }

    if (down === undefined) {
      this.sendKey(keysym, code, true);
      this.sendKey(keysym, code, false);
      return;
    }

    const scancode = code === null ? undefined : XtScancode[code];

    if (this._qemuExtKeyEventSupported && scancode) {
      // 0 is NoSymbol
      keysym = keysym || 0;

      Log.Info(
        "Sending key (" +
          (down ? "down" : "up") +
          "): keysym " +
          keysym +
          ", scancode " +
          scancode,
      );

      RFB.messages.QEMUExtendedKeyEvent(this._sock, keysym, down, scancode);
    } else {
      if (!keysym) {
        return;
      }
      Log.Info(`Sending keysym (${down ? "down" : "up"}): ${keysym}`);
      RFB.messages.keyEvent(this._sock, keysym, down ? 1 : 0);
    }
  }

  clipboardPasteFrom(text: string): void {
    if (this._rfbConnectionState !== "connected") {
      return;
    }

    if (
      this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] &&
      this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]
    ) {
      this._clipboardText = text;
      RFB.messages.extendedClipboardNotify(this._sock, [
        extendedClipboardFormatText,
      ]);
    } else {
      let length = 0;
      for (const _codePoint of text) {
        length++;
      }

      const data = new Uint8Array(length);

      let i = 0;
      for (const codePoint of text) {
        let code = codePoint.codePointAt(0) ?? 0;

        /* Only ISO 8859-1 is supported */
        if (code > 0xff) {
          code = 0x3f; // '?'
        }

        data[i++] = code;
      }

      RFB.messages.clientCutText(this._sock, data);
    }
  }

  // Sets the display scale directly; _updateScale() keeps reapplying it
  // when noVNC's ResizeObserver or a framebuffer resize reruns scaling.
  setBaseScale(scale: number): void {
    this._baseScale = scale;
    this._display.scale = scale;
  }

  // Safe to call repeatedly: rate-limited to one pending request per
  // 100ms and a no-op when the framebuffer already matches the target.
  requestResize(): void {
    this._requestRemoteResize();
  }

  sendPointer(x: number, y: number, buttonMask: number): void {
    if (this._rfbConnectionState !== "connected") {
      return;
    }
    // Pointer coordinates are unsigned 16-bit on the wire; clamp to the
    // framebuffer so letterbox-area events can't wrap around.
    const maxX = Math.max(0, this._fbWidth - 1);
    const maxY = Math.max(0, this._fbHeight - 1);
    RFB.messages.pointerEvent(
      this._sock,
      Math.min(maxX, Math.max(0, Math.round(x))),
      Math.min(maxY, Math.max(0, Math.round(y))),
      buttonMask,
    );
  }

  get connected(): boolean {
    return this._rfbConnectionState === "connected";
  }

  get fbSize(): FbSize {
    return { width: this._fbWidth, height: this._fbHeight };
  }

  get canvasElement(): HTMLCanvasElement {
    return this._canvas;
  }

  get screenElement(): HTMLDivElement {
    return this._screen;
  }

  // ===== PRIVATE METHODS =====

  _connect() {
    Log.Debug(">> RFB.connect");

    Log.Info(`attaching ${this._rawChannel} to Websock`);
    if (!this._rawChannel) {
      throw new Error("WebSocket channel is unavailable");
    }
    this._sock.attach(this._rawChannel);

    if (this._sock.readyState === "closed") {
      throw Error("Cannot use already closed WebSocket channel");
    }

    if (this._sock.readyState === "open") {
      // FIXME: _socketOpen() can in theory call _fail(), which
      //        isn't allowed this early, but I'm not sure that can
      //        happen without a bug messing up our state variables
      this._socketOpen();
    }

    // Make our elements part of the page
    this._target.appendChild(this._screen);

    // Monitor size changes of the screen element
    this._resizeObserver.observe(this._screen);

    // No input listeners: the app's own overlay drives all input via
    // sendKey()/sendPointer()/clipboardPasteFrom().

    Log.Debug("<< RFB.connect");
  }

  _disconnect() {
    Log.Debug(">> RFB.disconnect");
    this._resizeObserver.disconnect();
    this._sock.close();
    try {
      this._target.removeChild(this._screen);
    } catch (e) {
      if ((e as DOMException).name === "NotFoundError") {
        // Some cases where the initial connection fails
        // can disconnect before the _screen is created
      } else {
        throw e;
      }
    }
    clearTimeout(this._resizeTimeout);
    clearTimeout(this._resizeRequestDebounce);
    Log.Debug("<< RFB.disconnect");
  }

  _socketOpen() {
    if (
      this._rfbConnectionState === "connecting" &&
      this._rfbInitState === ""
    ) {
      this._rfbInitState = "ProtocolVersion";
      Log.Debug("Starting VNC handshake");
    } else {
      this._fail(
        `Unexpected server connection while ${this._rfbConnectionState}`,
      );
    }
  }

  _socketClose(e: CloseEvent): void {
    Log.Debug("WebSocket on-close event");
    let msg = "";
    if (e.code) {
      msg = `(code: ${e.code}`;
      if (e.reason) {
        msg += `, reason: ${e.reason}`;
      }
      msg += ")";
    }
    switch (this._rfbConnectionState) {
      case "connecting":
        this._fail(`Connection closed ${msg}`);
        break;
      case "connected":
        // Handle disconnects that were initiated server-side
        this._updateConnectionState("disconnecting");
        this._updateConnectionState("disconnected");
        break;
      case "disconnecting":
        // Normal disconnection path
        this._updateConnectionState("disconnected");
        break;
      case "disconnected":
        this._fail(
          `Unexpected server disconnect when already disconnected ${msg}`,
        );
        break;
      default:
        this._fail(`Unexpected server disconnect before connecting ${msg}`);
        break;
    }
    this._sock.off("close");
    // Delete reference to raw channel to allow cleanup.
    this._rawChannel = null;
  }

  _socketError(_e: Event): void {
    Log.Warn("WebSocket on-error event");
  }

  _setDesktopName(name: string): void {
    this._fbName = name;
    this.dispatchEvent(
      new CustomEvent("desktopname", { detail: { name: this._fbName } }),
    );
  }

  _saveExpectedClientSize() {
    this._expectedClientWidth = this._screen.clientWidth;
    this._expectedClientHeight = this._screen.clientHeight;
  }

  _currentClientSize() {
    return [this._screen.clientWidth, this._screen.clientHeight];
  }

  _clientHasExpectedSize() {
    const [currentWidth, currentHeight] = this._currentClientSize();
    return (
      currentWidth === this._expectedClientWidth &&
      currentHeight === this._expectedClientHeight
    );
  }

  // Handle browser window resizes
  _handleResize() {
    // Don't change anything if the client size is already as expected
    if (this._clientHasExpectedSize()) {
      return;
    }
    // If the window resized then our screen element might have
    // as well. Update the viewport dimensions.
    window.requestAnimationFrame(() => {
      this._updateScale();
      this._saveExpectedClientSize();
    });

    // Stock noVNC requested the remote resize right here, straight from
    // its ResizeObserver — so a continuous window drag resized the
    // remote desktop ~10×/s and the session visibly flickered. Keep the
    // local display updates above immediate but debounce the remote
    // resize request until the size has been stable for a moment.
    clearTimeout(this._resizeRequestDebounce);
    this._resizeRequestDebounce = setTimeout(() => {
      if (this._rfbConnectionState !== "connected") {
        return;
      }
      this._requestRemoteResize();
    }, RESIZE_REQUEST_DEBOUNCE_MS);
  }

  // Stock noVNC forced display.scale to 1.0 here (or autoscaled to the
  // container); this fork keeps the app-controlled base scale applied so
  // exact HiDPI fit/zoom survives ResizeObserver and framebuffer-resize
  // reruns.
  _updateScale() {
    this._display.scale = this._baseScale;
  }

  // Requests a change of remote desktop size. This message is an extension
  // and may only be sent if we have received an ExtendedDesktopSize message
  _requestRemoteResize() {
    if (!this._resizeSession) {
      return;
    }
    if (!this._supportsSetDesktopSize) {
      return;
    }

    // Rate limit to one pending resize at a time
    if (this._pendingRemoteResize) {
      return;
    }

    // And no more than once every 100ms
    if (Date.now() - this._lastResize < 100) {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = setTimeout(
        this._requestRemoteResize.bind(this),
        100 - (Date.now() - this._lastResize),
      );
      return;
    }
    this._resizeTimeout = undefined;

    const size = this._screenSize();

    // Do we actually change anything?
    if (size.w === this._fbWidth && size.h === this._fbHeight) {
      return;
    }

    this._pendingRemoteResize = true;
    this._lastResize = Date.now();
    RFB.messages.setDesktopSize(
      this._sock,
      Math.floor(size.w),
      Math.floor(size.h),
      this._screenID,
      this._screenFlags,
    );

    Log.Debug(`Requested new desktop size: ${size.w}x${size.h}`);
  }

  // Gets the desired framebuffer size: the app-injected device-pixel
  // target when set (sole source for setDesktopSize requests), otherwise
  // the container's CSS size.
  _screenSize() {
    if (this.computeTargetSize) {
      const { width, height } = this.computeTargetSize();
      return { w: width, h: height };
    }
    const r = this._screen.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /*
   * Connection states:
   *   connecting
   *   connected
   *   disconnecting
   *   disconnected - permanent state
   */
  _updateConnectionState(state: ConnectionState): void {
    const oldstate = this._rfbConnectionState;

    if (state === oldstate) {
      Log.Debug(`Already in state '${state}', ignoring`);
      return;
    }

    // The 'disconnected' state is permanent for each RFB object
    if (oldstate === "disconnected") {
      Log.ErrorLog("Tried changing state of a disconnected RFB object");
      return;
    }

    // Ensure proper transitions before doing anything
    switch (state) {
      case "connected":
        if (oldstate !== "connecting") {
          Log.ErrorLog(
            "Bad transition to connected state, " +
              "previous connection state: " +
              oldstate,
          );
          return;
        }
        break;

      case "disconnected":
        if (oldstate !== "disconnecting") {
          Log.ErrorLog(
            "Bad transition to disconnected state, " +
              "previous connection state: " +
              oldstate,
          );
          return;
        }
        break;

      case "connecting":
        if (oldstate !== "") {
          Log.ErrorLog(
            "Bad transition to connecting state, " +
              "previous connection state: " +
              oldstate,
          );
          return;
        }
        break;

      case "disconnecting":
        if (oldstate !== "connected" && oldstate !== "connecting") {
          Log.ErrorLog(
            "Bad transition to disconnecting state, " +
              "previous connection state: " +
              oldstate,
          );
          return;
        }
        break;

      default:
        Log.ErrorLog(`Unknown connection state: ${state}`);
        return;
    }

    // State change actions

    this._rfbConnectionState = state;

    Log.Debug(`New state '${state}', was '${oldstate}'.`);

    if (this._disconnTimer && state !== "disconnecting") {
      Log.Debug("Clearing disconnect timer");
      clearTimeout(this._disconnTimer);
      this._disconnTimer = undefined;

      // make sure we don't get a double event
      this._sock.off("close");
    }

    switch (state) {
      case "connecting":
        this._connect();
        break;

      case "connected":
        this.dispatchEvent(new CustomEvent("connect", { detail: {} }));
        break;

      case "disconnecting":
        this._disconnect();

        this._disconnTimer = setTimeout(() => {
          Log.ErrorLog("Disconnection timed out.");
          this._updateConnectionState("disconnected");
        }, DISCONNECT_TIMEOUT * 1000);
        break;

      case "disconnected":
        this.dispatchEvent(
          new CustomEvent("disconnect", {
            detail: { clean: this._rfbCleanDisconnect },
          }),
        );
        break;
    }
  }

  /* Print errors and disconnect
   *
   * The parameter 'details' is used for information that
   * should be logged but not sent to the user interface.
   */
  _fail(details: string): boolean {
    switch (this._rfbConnectionState) {
      case "disconnecting":
        Log.ErrorLog(`Failed when disconnecting: ${details}`);
        break;
      case "connected":
        Log.ErrorLog(`Failed while connected: ${details}`);
        break;
      case "connecting":
        Log.ErrorLog(`Failed when connecting: ${details}`);
        break;
      default:
        Log.ErrorLog(`RFB failure: ${details}`);
        break;
    }
    this._rfbCleanDisconnect = false; //This is sent to the UI

    // Transition to disconnected without waiting for socket to close
    this._updateConnectionState("disconnecting");
    this._updateConnectionState("disconnected");

    return false;
  }

  _handleMessage() {
    if (this._sock.rQwait("message", 1)) {
      Log.Warn("handleMessage called on an empty receive queue");
      return;
    }

    switch (this._rfbConnectionState) {
      case "disconnected":
        Log.ErrorLog("Got data while disconnected");
        break;
      case "connected":
        while (true) {
          if (this._flushing) {
            break;
          }
          if (!this._normalMsg()) {
            break;
          }
          if (this._sock.rQwait("message", 1)) {
            break;
          }
        }
        break;
      case "connecting":
        while (this._rfbConnectionState === "connecting") {
          if (!this._initMsg()) {
            break;
          }
        }
        break;
      default:
        Log.ErrorLog("Got data while in an invalid state");
        break;
    }
  }

  // Message handlers

  _negotiateProtocolVersion() {
    if (this._sock.rQwait("version", 12)) {
      return false;
    }

    const sversion = this._sock.rQshiftStr(12).substr(4, 7);
    Log.Info(`Server ProtocolVersion: ${sversion}`);
    switch (sversion) {
      case "003.003":
      case "003.006": // UltraVNC
        this._rfbVersion = 3.3;
        break;
      case "003.007":
        this._rfbVersion = 3.7;
        break;
      case "003.008":
      case "003.889": // Apple Remote Desktop
      case "004.000": // Intel AMT KVM
      case "004.001": // RealVNC 4.6
      case "005.000": // RealVNC 5.3
        this._rfbVersion = 3.8;
        break;
      default:
        return this._fail(`Invalid server version ${sversion}`);
    }

    if (this._rfbVersion > this._rfbMaxVersion) {
      this._rfbVersion = this._rfbMaxVersion;
    }

    const cversion =
      "00" +
      parseInt(String(this._rfbVersion), 10) +
      ".00" +
      ((this._rfbVersion * 10) % 10);
    this._sock.sQpushString(`RFB ${cversion}\n`);
    this._sock.flush();
    Log.Debug(`Sent ProtocolVersion: ${cversion}`);

    this._rfbInitState = "Security";
  }

  _isSupportedSecurityType(type: number): boolean {
    return type === securityTypeNone;
  }

  _negotiateSecurity() {
    if (this._rfbVersion >= 3.7) {
      // Server sends supported list, client decides
      const numTypes = this._sock.rQshift8();
      if (this._sock.rQwait("security type", numTypes, 1)) {
        return false;
      }

      if (numTypes === 0) {
        this._rfbInitState = "SecurityReason";
        this._securityContext = "no security types";
        this._securityStatus = 1;
        return true;
      }

      const types = this._sock.rQshiftBytes(numTypes);
      Log.Debug(`Server security types: ${types}`);

      // Look for a matching security type in the order that the
      // server prefers
      this._rfbAuthScheme = -1;
      for (const type of types) {
        if (this._isSupportedSecurityType(type)) {
          this._rfbAuthScheme = type;
          break;
        }
      }

      if (this._rfbAuthScheme === -1) {
        return this._fail(`Unsupported security types (types: ${types})`);
      }

      this._sock.sQpush8(this._rfbAuthScheme);
      this._sock.flush();
    } else {
      // Server decides
      if (this._sock.rQwait("security scheme", 4)) {
        return false;
      }
      this._rfbAuthScheme = this._sock.rQshift32();

      if (this._rfbAuthScheme === 0) {
        this._rfbInitState = "SecurityReason";
        this._securityContext = "authentication scheme";
        this._securityStatus = 1;
        return true;
      }
    }

    this._rfbInitState = "Authentication";
    Log.Debug(`Authenticating using scheme: ${this._rfbAuthScheme}`);

    return true;
  }

  _handleSecurityReason() {
    if (this._sock.rQwait("reason length", 4)) {
      return false;
    }
    const strlen = this._sock.rQshift32();
    let reason = "";

    if (strlen > 0) {
      if (this._sock.rQwait("reason", strlen, 4)) {
        return false;
      }
      reason = this._sock.rQshiftStr(strlen);
    }

    if (reason !== "") {
      this.dispatchEvent(
        new CustomEvent("securityfailure", {
          detail: { status: this._securityStatus, reason: reason },
        }),
      );

      return this._fail(
        "Security negotiation failed on " +
          this._securityContext +
          " (reason: " +
          reason +
          ")",
      );
    } else {
      this.dispatchEvent(
        new CustomEvent("securityfailure", {
          detail: { status: this._securityStatus },
        }),
      );

      return this._fail(
        `Security negotiation failed on ${this._securityContext}`,
      );
    }
  }

  _negotiateAuthentication() {
    switch (this._rfbAuthScheme) {
      case securityTypeNone:
        if (this._rfbVersion >= 3.8) {
          this._rfbInitState = "SecurityResult";
        } else {
          this._rfbInitState = "ClientInitialisation";
        }
        return true;

      default:
        return this._fail(
          `Unsupported auth scheme (scheme: ${this._rfbAuthScheme})`,
        );
    }
  }

  _handleSecurityResult() {
    if (this._sock.rQwait("VNC auth response ", 4)) {
      return false;
    }

    const status = this._sock.rQshift32();

    if (status === 0) {
      // OK
      this._rfbInitState = "ClientInitialisation";
      Log.Debug("Authentication OK");
      return true;
    } else {
      if (this._rfbVersion >= 3.8) {
        this._rfbInitState = "SecurityReason";
        this._securityContext = "security result";
        this._securityStatus = status;
        return true;
      } else {
        this.dispatchEvent(
          new CustomEvent("securityfailure", { detail: { status: status } }),
        );

        return this._fail("Security handshake failed");
      }
    }
  }

  _negotiateServerInit() {
    if (this._sock.rQwait("server initialization", 24)) {
      return false;
    }

    /* Screen size */
    const width = this._sock.rQshift16();
    const height = this._sock.rQshift16();

    /* PIXEL_FORMAT */
    const bpp = this._sock.rQshift8();
    const depth = this._sock.rQshift8();
    const bigEndian = this._sock.rQshift8();
    const trueColor = this._sock.rQshift8();

    const redMax = this._sock.rQshift16();
    const greenMax = this._sock.rQshift16();
    const blueMax = this._sock.rQshift16();
    const redShift = this._sock.rQshift8();
    const greenShift = this._sock.rQshift8();
    const blueShift = this._sock.rQshift8();
    this._sock.rQskipBytes(3); // padding

    // NB(directxman12): we don't want to call any callbacks or print messages until
    //                   *after* we're past the point where we could backtrack

    /* Connection name/title */
    const nameLength = this._sock.rQshift32();
    if (this._sock.rQwait("server init name", nameLength, 24)) {
      return false;
    }
    let name = this._sock.rQshiftStr(nameLength);
    name = decodeUTF8(name, true);

    // NB(directxman12): these are down here so that we don't run them multiple times
    //                   if we backtrack
    Log.Info(
      "Screen: " +
        width +
        "x" +
        height +
        ", bpp: " +
        bpp +
        ", depth: " +
        depth +
        ", bigEndian: " +
        bigEndian +
        ", trueColor: " +
        trueColor +
        ", redMax: " +
        redMax +
        ", greenMax: " +
        greenMax +
        ", blueMax: " +
        blueMax +
        ", redShift: " +
        redShift +
        ", greenShift: " +
        greenShift +
        ", blueShift: " +
        blueShift,
    );

    // we're past the point where we could backtrack, so it's safe to call this
    this._setDesktopName(name);
    this._resize(width, height);

    this._fbDepth = 24;

    if (this._fbName === "Intel(r) AMT KVM") {
      Log.Warn(
        "Intel AMT KVM only supports 8/16 bit depths. Using low color mode.",
      );
      this._fbDepth = 8;
    }

    RFB.messages.pixelFormat(this._sock, this._fbDepth, true);
    this._sendEncodings();
    RFB.messages.fbUpdateRequest(
      this._sock,
      false,
      0,
      0,
      this._fbWidth,
      this._fbHeight,
    );

    this._updateConnectionState("connected");
    return true;
  }

  _sendEncodings() {
    const encs = [];

    // In preference order
    encs.push(encodings.encodingCopyRect);
    // Only supported with full depth support
    if (this._fbDepth === 24) {
      encs.push(encodings.encodingTight);
    }
    encs.push(encodings.encodingRaw);

    // Psuedo-encoding settings (fixed at noVNC's former defaults; the
    // runtime qualityLevel/compressionLevel knobs were never used)
    encs.push(encodings.pseudoEncodingQualityLevel0 + QUALITY_LEVEL);
    encs.push(encodings.pseudoEncodingCompressLevel0 + COMPRESSION_LEVEL);

    encs.push(encodings.pseudoEncodingDesktopSize);
    encs.push(encodings.pseudoEncodingLastRect);
    encs.push(encodings.pseudoEncodingQEMUExtendedKeyEvent);
    encs.push(encodings.pseudoEncodingExtendedDesktopSize);
    encs.push(encodings.pseudoEncodingFence);
    encs.push(encodings.pseudoEncodingContinuousUpdates);
    encs.push(encodings.pseudoEncodingDesktopName);
    encs.push(encodings.pseudoEncodingExtendedClipboard);

    // The cursor pseudo-encodings are deliberately never advertised:
    // they would make the server stop drawing the cursor into the
    // framebuffer, and this client renders no local cursor (the app's
    // input overlay sits above the canvas).

    RFB.messages.clientEncodings(this._sock, encs);
  }

  /* RFB protocol initialization states:
   *   ProtocolVersion
   *   Security
   *   Authentication
   *   SecurityResult
   *   ClientInitialization - not triggered by server message
   *   ServerInitialization
   */
  _initMsg() {
    switch (this._rfbInitState) {
      case "ProtocolVersion":
        return this._negotiateProtocolVersion();

      case "Security":
        return this._negotiateSecurity();

      case "Authentication":
        return this._negotiateAuthentication();

      case "SecurityResult":
        return this._handleSecurityResult();

      case "SecurityReason":
        return this._handleSecurityReason();

      case "ClientInitialisation":
        this._sock.sQpush8(1); // ClientInitialisation, always shared
        this._sock.flush();
        this._rfbInitState = "ServerInitialisation";
        return true;

      case "ServerInitialisation":
        return this._negotiateServerInit();

      default:
        return this._fail(`Unknown init state (state: ${this._rfbInitState})`);
    }
  }

  _handleSetColourMapMsg() {
    Log.Debug("SetColorMapEntries");

    return this._fail("Unexpected SetColorMapEntries message");
  }

  _handleServerCutText() {
    Log.Debug("ServerCutText");

    if (this._sock.rQwait("ServerCutText header", 7, 1)) {
      return false;
    }

    this._sock.rQskipBytes(3); // Padding

    let length = this._sock.rQshift32();
    length = toSigned32bit(length);

    if (this._sock.rQwait("ServerCutText content", Math.abs(length), 8)) {
      return false;
    }

    if (length >= 0) {
      //Standard msg
      const text = this._sock.rQshiftStr(length);

      this.dispatchEvent(
        new CustomEvent("clipboard", { detail: { text: text } }),
      );
    } else {
      //Extended msg.
      length = Math.abs(length);
      const flags = this._sock.rQshift32();
      const formats = flags & 0x0000ffff;
      const actions = flags & 0xff000000;

      const isCaps = !!(actions & extendedClipboardActionCaps);
      if (isCaps) {
        this._clipboardServerCapabilitiesFormats = {};
        this._clipboardServerCapabilitiesActions = {};

        // Update our server capabilities for Formats
        for (let i = 0; i <= 15; i++) {
          const index = 1 << i;

          // Check if format flag is set.
          if (formats & index) {
            this._clipboardServerCapabilitiesFormats[index] = true;
            // We don't send unsolicited clipboard, so we
            // ignore the size
            this._sock.rQshift32();
          }
        }

        // Update our server capabilities for Actions
        for (let i = 24; i <= 31; i++) {
          const index = 1 << i;
          this._clipboardServerCapabilitiesActions[index] = !!(actions & index);
        }

        /*  Caps handling done, send caps with the clients
                    capabilities set as a response */
        const clientActions = [
          extendedClipboardActionCaps,
          extendedClipboardActionRequest,
          extendedClipboardActionPeek,
          extendedClipboardActionNotify,
          extendedClipboardActionProvide,
        ];
        RFB.messages.extendedClipboardCaps(this._sock, clientActions, {
          extendedClipboardFormatText: 0,
        });
      } else if (actions === extendedClipboardActionRequest) {
        // Check if server has told us it can handle Provide and there is clipboard data to send.
        if (
          this._clipboardText != null &&
          this._clipboardServerCapabilitiesActions[
            extendedClipboardActionProvide
          ]
        ) {
          if (formats & extendedClipboardFormatText) {
            RFB.messages.extendedClipboardProvide(
              this._sock,
              [extendedClipboardFormatText],
              [this._clipboardText],
            );
          }
        }
      } else if (actions === extendedClipboardActionPeek) {
        if (
          this._clipboardServerCapabilitiesActions[
            extendedClipboardActionNotify
          ]
        ) {
          if (this._clipboardText != null) {
            RFB.messages.extendedClipboardNotify(this._sock, [
              extendedClipboardFormatText,
            ]);
          } else {
            RFB.messages.extendedClipboardNotify(this._sock, []);
          }
        }
      } else if (actions === extendedClipboardActionNotify) {
        if (
          this._clipboardServerCapabilitiesActions[
            extendedClipboardActionRequest
          ]
        ) {
          if (formats & extendedClipboardFormatText) {
            RFB.messages.extendedClipboardRequest(this._sock, [
              extendedClipboardFormatText,
            ]);
          }
        }
      } else if (actions === extendedClipboardActionProvide) {
        if (!(formats & extendedClipboardFormatText)) {
          return true;
        }
        // Ignore what we had in our clipboard client side.
        this._clipboardText = null;

        // FIXME: Should probably verify that this data was actually requested
        const zlibStream = this._sock.rQshiftBytes(length - 4);
        const streamInflator = new Inflator();
        let textData: Uint8Array | null = null;

        streamInflator.setInput(zlibStream);
        for (let i = 0; i <= 15; i++) {
          const format = 1 << i;

          if (formats & format) {
            let size = 0x00;
            const sizeArray = streamInflator.inflate(4);

            size |= sizeArray[0] << 24;
            size |= sizeArray[1] << 16;
            size |= sizeArray[2] << 8;
            size |= sizeArray[3];
            const chunk = streamInflator.inflate(size);

            if (format === extendedClipboardFormatText) {
              textData = chunk;
            }
          }
        }
        streamInflator.setInput(null);

        if (textData !== null) {
          let tmpText = "";
          for (let i = 0; i < textData.length; i++) {
            tmpText += String.fromCharCode(textData[i]);
          }

          let decoded = decodeUTF8(tmpText);
          if (
            decoded.length > 0 &&
            "\0" === decoded.charAt(decoded.length - 1)
          ) {
            decoded = decoded.slice(0, -1);
          }

          decoded = decoded.replaceAll("\r\n", "\n");

          this.dispatchEvent(
            new CustomEvent("clipboard", { detail: { text: decoded } }),
          );
        }
      } else {
        return this._fail(
          `Unexpected action in extended clipboard message: ${actions}`,
        );
      }
    }
    return true;
  }

  _handleServerFenceMsg() {
    if (this._sock.rQwait("ServerFence header", 8, 1)) {
      return false;
    }
    this._sock.rQskipBytes(3); // Padding
    let flags = this._sock.rQshift32();
    let length = this._sock.rQshift8();

    if (this._sock.rQwait("ServerFence payload", length, 9)) {
      return false;
    }

    if (length > 64) {
      Log.Warn(`Bad payload length (${length}) in fence response`);
      length = 64;
    }

    const payload = this._sock.rQshiftStr(length);

    this._supportsFence = true;

    /*
     * Fence flags
     *
     *  (1<<0)  - BlockBefore
     *  (1<<1)  - BlockAfter
     *  (1<<2)  - SyncNext
     *  (1<<31) - Request
     */

    if (!(flags & (1 << 31))) {
      return this._fail("Unexpected fence response");
    }

    // Filter out unsupported flags
    // FIXME: support syncNext
    flags &= (1 << 0) | (1 << 1);

    // BlockBefore and BlockAfter are automatically handled by
    // the fact that we process each incoming message
    // synchronuosly.
    RFB.messages.clientFence(this._sock, flags, payload);

    return true;
  }

  _normalMsg() {
    const msgType = this._FBU.rects > 0 ? 0 : this._sock.rQshift8();
    switch (msgType) {
      case 0: {
        // FramebufferUpdate
        const ret = this._framebufferUpdate();
        if (ret && !this._enabledContinuousUpdates) {
          RFB.messages.fbUpdateRequest(
            this._sock,
            true,
            0,
            0,
            this._fbWidth,
            this._fbHeight,
          );
        }
        return ret;
      }

      case 1: // SetColorMapEntries
        return this._handleSetColourMapMsg();

      case 2: // Bell
        Log.Debug("Bell");
        this.dispatchEvent(new CustomEvent("bell", { detail: {} }));
        return true;

      case 3: // ServerCutText
        return this._handleServerCutText();

      case 150: {
        // EndOfContinuousUpdates
        const first = !this._supportsContinuousUpdates;
        this._supportsContinuousUpdates = true;
        this._enabledContinuousUpdates = false;
        if (first) {
          this._enabledContinuousUpdates = true;
          this._updateContinuousUpdates();
          Log.Info("Enabling continuous updates.");
        } else {
          // FIXME: We need to send a framebufferupdaterequest here
          // if we add support for turning off continuous updates
        }
        return true;
      }

      case 248: // ServerFence
        return this._handleServerFenceMsg();

      default:
        this._fail(`Unexpected server message (type ${msgType})`);
        Log.Debug(`sock.rQpeekBytes(30): ${this._sock.rQpeekBytes(30)}`);
        return true;
    }
  }

  _framebufferUpdate() {
    if (this._FBU.rects === 0) {
      if (this._sock.rQwait("FBU header", 3, 1)) {
        return false;
      }
      this._sock.rQskipBytes(1); // Padding
      this._FBU.rects = this._sock.rQshift16();

      // Make sure the previous frame is fully rendered first
      // to avoid building up an excessive queue
      if (this._display.pending()) {
        this._flushing = true;
        this._display.flush().then(() => {
          this._flushing = false;
          // Resume processing
          if (!this._sock.rQwait("message", 1)) {
            this._handleMessage();
          }
        });
        return false;
      }
    }

    while (this._FBU.rects > 0) {
      if (this._FBU.encoding === null) {
        if (this._sock.rQwait("rect header", 12)) {
          return false;
        }
        /* New FramebufferUpdate */

        this._FBU.x = this._sock.rQshift16();
        this._FBU.y = this._sock.rQshift16();
        this._FBU.width = this._sock.rQshift16();
        this._FBU.height = this._sock.rQshift16();
        this._FBU.encoding = this._sock.rQshift32();
        /* Encodings are signed */
        this._FBU.encoding >>= 0;
      }

      if (!this._handleRect()) {
        return false;
      }

      this._FBU.rects--;
      this._FBU.encoding = null;
    }

    this._display.flip();

    return true; // We finished this FBU
  }

  _handleRect() {
    switch (this._FBU.encoding) {
      case encodings.pseudoEncodingLastRect:
        this._FBU.rects = 1; // Will be decreased when we return
        return true;

      case encodings.pseudoEncodingQEMUExtendedKeyEvent:
        this._qemuExtKeyEventSupported = true;
        return true;

      case encodings.pseudoEncodingDesktopName:
        return this._handleDesktopName();

      case encodings.pseudoEncodingDesktopSize:
        this._resize(this._FBU.width, this._FBU.height);
        return true;

      case encodings.pseudoEncodingExtendedDesktopSize:
        return this._handleExtendedDesktopSize();

      default:
        return this._handleDataRect();
    }
  }

  _handleDesktopName() {
    if (this._sock.rQwait("DesktopName", 4)) {
      return false;
    }

    const length = this._sock.rQshift32();

    if (this._sock.rQwait("DesktopName", length, 4)) {
      return false;
    }

    let name = this._sock.rQshiftStr(length);
    name = decodeUTF8(name, true);

    this._setDesktopName(name);

    return true;
  }

  _handleExtendedDesktopSize() {
    if (this._sock.rQwait("ExtendedDesktopSize", 4)) {
      return false;
    }

    const numberOfScreens = this._sock.rQpeek8();

    const bytes = 4 + numberOfScreens * 16;
    if (this._sock.rQwait("ExtendedDesktopSize", bytes)) {
      return false;
    }

    const firstUpdate = !this._supportsSetDesktopSize;
    this._supportsSetDesktopSize = true;

    this._sock.rQskipBytes(1); // number-of-screens
    this._sock.rQskipBytes(3); // padding

    for (let i = 0; i < numberOfScreens; i += 1) {
      // Save the id and flags of the first screen
      if (i === 0) {
        this._screenID = this._sock.rQshift32(); // id
        this._sock.rQskipBytes(2); // x-position
        this._sock.rQskipBytes(2); // y-position
        this._sock.rQskipBytes(2); // width
        this._sock.rQskipBytes(2); // height
        this._screenFlags = this._sock.rQshift32(); // flags
      } else {
        this._sock.rQskipBytes(16);
      }
    }

    /*
     * The x-position indicates the reason for the change:
     *
     *  0 - server resized on its own
     *  1 - this client requested the resize
     *  2 - another client requested the resize
     */

    if (this._FBU.x === 1) {
      this._pendingRemoteResize = false;
    }

    // We need to handle errors when we requested the resize.
    if (this._FBU.x === 1 && this._FBU.y !== 0) {
      let msg = "";
      // The y-position indicates the status code from the server
      switch (this._FBU.y) {
        case 1:
          msg = "Resize is administratively prohibited";
          break;
        case 2:
          msg = "Out of resources";
          break;
        case 3:
          msg = "Invalid screen layout";
          break;
        default:
          msg = "Unknown reason";
          break;
      }
      Log.Warn(`Server did not accept the resize request: ${msg}`);
    } else {
      this._resize(this._FBU.width, this._FBU.height);
    }

    // Normally we only apply the current resize mode after a
    // window resize event. However there is no such trigger on the
    // initial connect. And we don't know if the server supports
    // resizing until we've gotten here.
    if (firstUpdate) {
      this._requestRemoteResize();
    }

    if (this._FBU.x === 1 && this._FBU.y === 0) {
      // We might have resized again whilst waiting for the
      // previous request, so check if we are in sync
      this._requestRemoteResize();
    }

    return true;
  }

  _handleDataRect(): boolean {
    const encoding = this._FBU.encoding;
    if (encoding === null) {
      return false;
    }
    const decoder = this._decoders[encoding];
    if (!decoder) {
      this._fail(`Unsupported encoding (encoding: ${this._FBU.encoding})`);
      return false;
    }

    try {
      return decoder.decodeRect(
        this._FBU.x,
        this._FBU.y,
        this._FBU.width,
        this._FBU.height,
        this._sock,
        this._display,
        this._fbDepth,
      );
    } catch (err) {
      this._fail(`Error decoding rect: ${String(err)}`);
      return false;
    }
  }

  _updateContinuousUpdates() {
    if (!this._enabledContinuousUpdates) {
      return;
    }

    RFB.messages.enableContinuousUpdates(
      this._sock,
      true,
      0,
      0,
      this._fbWidth,
      this._fbHeight,
    );
  }

  // Handle resize-messages from the server
  _resize(width: number, height: number): void {
    this._fbWidth = width;
    this._fbHeight = height;

    this._display.resize(this._fbWidth, this._fbHeight);

    // Adjust the visible viewport based on the new dimensions
    this._updateScale();

    this._updateContinuousUpdates();

    // Keep this size until browser client size changes
    this._saveExpectedClientSize();

    this.dispatchEvent(
      new CustomEvent("fbresize", { detail: { width: width, height: height } }),
    );
  }

  // Class Methods
  static messages = {
    keyEvent(sock: Websock, keysym: number, down: number) {
      sock.sQpush8(4); // msg-type
      sock.sQpush8(down);

      sock.sQpush16(0);

      sock.sQpush32(keysym);

      sock.flush();
    },

    QEMUExtendedKeyEvent(
      sock: Websock,
      keysym: number,
      down: boolean,
      keycode: number,
    ) {
      function getRFBkeycode(xtScanCode: number): number {
        const upperByte = keycode >> 8;
        const lowerByte = keycode & 0x00ff;
        if (upperByte === 0xe0 && lowerByte < 0x7f) {
          return lowerByte | 0x80;
        }
        return xtScanCode;
      }

      sock.sQpush8(255); // msg-type
      sock.sQpush8(0); // sub msg-type

      sock.sQpush16(down ? 1 : 0);

      sock.sQpush32(keysym);

      const RFBkeycode = getRFBkeycode(keycode);

      sock.sQpush32(RFBkeycode);

      sock.flush();
    },

    pointerEvent(sock: Websock, x: number, y: number, mask: number) {
      sock.sQpush8(5); // msg-type

      // Marker bit must be set to 0, otherwise the server might
      // confuse the marker bit with the highest bit in a normal
      // PointerEvent message.
      mask = mask & 0x7f;
      sock.sQpush8(mask);

      sock.sQpush16(x);
      sock.sQpush16(y);

      sock.flush();
    },

    // Used to build Notify and Request data.
    _buildExtendedClipboardFlags(actions: number[], formats: number[]) {
      const data = new Uint8Array(4);
      let formatFlag = 0x00000000;
      let actionFlag = 0x00000000;

      for (let i = 0; i < actions.length; i++) {
        actionFlag |= actions[i];
      }

      for (let i = 0; i < formats.length; i++) {
        formatFlag |= formats[i];
      }

      data[0] = actionFlag >> 24; // Actions
      data[1] = 0x00; // Reserved
      data[2] = 0x00; // Reserved
      data[3] = formatFlag; // Formats

      return data;
    },

    extendedClipboardProvide(
      sock: Websock,
      formats: number[],
      inData: string[],
    ) {
      // Deflate incomming data and their sizes
      const deflator = new Deflator();
      const dataToDeflate = [];

      for (let i = 0; i < formats.length; i++) {
        // We only support the format Text at this time
        if (formats[i] !== extendedClipboardFormatText) {
          throw new Error(
            "Unsupported extended clipboard format for Provide message.",
          );
        }

        // Change lone \r or \n into \r\n as defined in rfbproto
        inData[i] = inData[i].replace(/\r\n|\r|\n/gm, "\r\n");

        // Check if it already has \0
        const text = encodeUTF8(`${inData[i]}\0`);

        dataToDeflate.push(
          (text.length >> 24) & 0xff,
          (text.length >> 16) & 0xff,
          (text.length >> 8) & 0xff,
          text.length & 0xff,
        );

        for (let j = 0; j < text.length; j++) {
          dataToDeflate.push(text.charCodeAt(j));
        }
      }

      const deflatedData = deflator.deflate(new Uint8Array(dataToDeflate));

      // Build data  to send
      const data = new Uint8Array(4 + deflatedData.length);
      data.set(
        RFB.messages._buildExtendedClipboardFlags(
          [extendedClipboardActionProvide],
          formats,
        ),
      );
      data.set(deflatedData, 4);

      RFB.messages.clientCutText(sock, data, true);
    },

    extendedClipboardNotify(sock: Websock, formats: number[]) {
      const flags = RFB.messages._buildExtendedClipboardFlags(
        [extendedClipboardActionNotify],
        formats,
      );
      RFB.messages.clientCutText(sock, flags, true);
    },

    extendedClipboardRequest(sock: Websock, formats: number[]) {
      const flags = RFB.messages._buildExtendedClipboardFlags(
        [extendedClipboardActionRequest],
        formats,
      );
      RFB.messages.clientCutText(sock, flags, true);
    },

    extendedClipboardCaps(
      sock: Websock,
      actions: number[],
      formats: Record<string, number>,
    ) {
      const formatKeys = Object.keys(formats);
      const data = new Uint8Array(4 + 4 * formatKeys.length);

      formatKeys.map((x) => parseInt(x, 10));
      formatKeys.sort((a, b) => Number(a) - Number(b));

      data.set(RFB.messages._buildExtendedClipboardFlags(actions, []));

      let loopOffset = 4;
      for (let i = 0; i < formatKeys.length; i++) {
        data[loopOffset] = formats[formatKeys[i]] >> 24;
        data[loopOffset + 1] = formats[formatKeys[i]] >> 16;
        data[loopOffset + 2] = formats[formatKeys[i]] >> 8;
        data[loopOffset + 3] = formats[formatKeys[i]] >> 0;

        loopOffset += 4;
        data[3] |= 1 << Number(formatKeys[i]); // Update our format flags
      }

      RFB.messages.clientCutText(sock, data, true);
    },

    clientCutText(sock: Websock, data: Uint8Array, extended = false) {
      sock.sQpush8(6); // msg-type

      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding

      const length = extended ? toUnsigned32bit(-data.length) : data.length;

      sock.sQpush32(length);
      sock.sQpushBytes(data);
      sock.flush();
    },

    setDesktopSize(
      sock: Websock,
      width: number,
      height: number,
      id: number,
      flags: number,
    ) {
      sock.sQpush8(251); // msg-type

      sock.sQpush8(0); // padding

      sock.sQpush16(width);
      sock.sQpush16(height);

      sock.sQpush8(1); // number-of-screens

      sock.sQpush8(0); // padding

      // screen array
      sock.sQpush32(id);
      sock.sQpush16(0); // x-position
      sock.sQpush16(0); // y-position
      sock.sQpush16(width);
      sock.sQpush16(height);
      sock.sQpush32(flags);

      sock.flush();
    },

    clientFence(sock: Websock, flags: number, payload: string) {
      sock.sQpush8(248); // msg-type

      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding

      sock.sQpush32(flags);

      sock.sQpush8(payload.length);
      sock.sQpushString(payload);

      sock.flush();
    },

    enableContinuousUpdates(
      sock: Websock,
      enable: boolean,
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      sock.sQpush8(150); // msg-type

      sock.sQpush8(enable ? 1 : 0);

      sock.sQpush16(x);
      sock.sQpush16(y);
      sock.sQpush16(width);
      sock.sQpush16(height);

      sock.flush();
    },

    pixelFormat(sock: Websock, depth: number, trueColor: boolean) {
      const bpp = depth > 16 ? 32 : depth > 8 ? 16 : 8;

      const bits = Math.floor(depth / 3);

      sock.sQpush8(0); // msg-type

      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding

      sock.sQpush8(bpp);
      sock.sQpush8(depth);
      sock.sQpush8(0); // little-endian
      sock.sQpush8(trueColor ? 1 : 0);

      sock.sQpush16((1 << bits) - 1); // red-max
      sock.sQpush16((1 << bits) - 1); // green-max
      sock.sQpush16((1 << bits) - 1); // blue-max

      sock.sQpush8(bits * 0); // red-shift
      sock.sQpush8(bits * 1); // green-shift
      sock.sQpush8(bits * 2); // blue-shift

      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding
      sock.sQpush8(0); // padding

      sock.flush();
    },

    clientEncodings(sock: Websock, encodings: number[]) {
      sock.sQpush8(2); // msg-type

      sock.sQpush8(0); // padding

      sock.sQpush16(encodings.length);
      for (let i = 0; i < encodings.length; i++) {
        sock.sQpush32(encodings[i]);
      }

      sock.flush();
    },

    fbUpdateRequest(
      sock: Websock,
      incremental: boolean,
      x: number,
      y: number,
      w: number,
      h: number,
    ) {
      if (typeof x === "undefined") {
        x = 0;
      }
      if (typeof y === "undefined") {
        y = 0;
      }

      sock.sQpush8(3); // msg-type

      sock.sQpush8(incremental ? 1 : 0);

      sock.sQpush16(x);
      sock.sQpush16(y);
      sock.sQpush16(w);
      sock.sQpush16(h);

      sock.flush();
    },
  };
}
