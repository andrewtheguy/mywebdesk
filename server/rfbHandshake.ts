import { vncAuthResponse } from "./vncAuth.js";

// RFB security phase handling for the proxy. The proxy completes the version
// and security handshake on both legs itself: it authenticates to the VNC
// server with VNC_PASSWORD (VncAuth DES challenge) and offers the browser
// security type None, so the password never leaves the server. After both
// handshakes succeed the byte streams are spliced verbatim.

export class HandshakeError extends Error {}

const RFB_VERSION_3_8 = "RFB 003.008\n";
const SECURITY_NONE = 1;
const SECURITY_VNCAUTH = 2;
const MAX_REASON_LENGTH = 1024;

export interface ByteReader {
  read(n: number): Promise<Buffer>;
  /** Bytes received but not consumed by read(). */
  rest(): Buffer;
  /** Stop consuming from the underlying stream. */
  detach(): void;
}

// Promise-based fixed-length reads over a chunk-event stream. `subscribe`
// attaches chunk/end handlers and returns the detach function.
export function createByteReader(
  subscribe: (
    onChunk: (chunk: Buffer) => void,
    onEnd: () => void,
  ) => () => void,
): ByteReader {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let pending: {
    n: number;
    resolve: (b: Buffer) => void;
    reject: (err: Error) => void;
  } | null = null;

  function pump(): void {
    if (!pending) return;
    if (buffer.length >= pending.n) {
      const { n, resolve } = pending;
      pending = null;
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      resolve(out);
    } else if (ended) {
      const { reject } = pending;
      pending = null;
      reject(new HandshakeError("connection closed during VNC handshake"));
    }
  }

  const detach = subscribe(
    (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    },
    () => {
      ended = true;
      pump();
    },
  );

  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        // Single-reader contract: overlapping reads would orphan the earlier
        // Promise. Fail fast instead of silently dropping it.
        if (pending) {
          reject(
            new HandshakeError("overlapping read() on a single-reader stream"),
          );
          return;
        }
        pending = { n, resolve, reject };
        pump();
      });
    },
    rest: () => buffer,
    detach,
  };
}

async function readReason(reader: ByteReader): Promise<string> {
  const length = (await reader.read(4)).readUInt32BE(0);
  if (length === 0) return "(no reason given)";
  return (await reader.read(Math.min(length, MAX_REASON_LENGTH))).toString(
    "latin1",
  );
}

// Proxy acting as an RFB client toward the real VNC server: negotiate
// version 3.8 and complete VncAuth (or None) using the configured password.
export async function performServerHandshake(
  reader: ByteReader,
  write: (data: Buffer) => void,
  password: string,
): Promise<void> {
  const greeting = (await reader.read(12)).toString("latin1");
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(greeting);
  if (!match) {
    throw new HandshakeError(
      `unexpected RFB greeting ${JSON.stringify(greeting)}`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 3 || minor < 8) {
    throw new HandshakeError(
      `unsupported RFB version ${major}.${minor} (proxy requires 3.8)`,
    );
  }
  write(Buffer.from(RFB_VERSION_3_8, "latin1"));

  const numTypes = (await reader.read(1))[0];
  if (numTypes === 0) {
    throw new HandshakeError(
      `VNC server refused connection: ${await readReason(reader)}`,
    );
  }
  const types = Array.from(await reader.read(numTypes));

  let chosen: number;
  if (password && types.includes(SECURITY_VNCAUTH)) {
    chosen = SECURITY_VNCAUTH;
  } else if (types.includes(SECURITY_NONE)) {
    chosen = SECURITY_NONE;
  } else if (types.includes(SECURITY_VNCAUTH)) {
    throw new HandshakeError(
      "VNC server requires a password but VNC_PASSWORD is not set",
    );
  } else {
    throw new HandshakeError(
      `no supported VNC security type (server offers: ${types.join(", ")})`,
    );
  }
  write(Buffer.from([chosen]));

  if (chosen === SECURITY_VNCAUTH) {
    const challenge = await reader.read(16);
    write(vncAuthResponse(password, challenge));
  }

  const result = (await reader.read(4)).readUInt32BE(0);
  if (result !== 0) {
    throw new HandshakeError(
      `VNC authentication failed: ${await readReason(reader)}`,
    );
  }
}

// Proxy acting as an RFB server toward the browser: advertise 3.8 and offer
// only security type None (the proxy already authenticated upstream).
export async function performClientHandshake(
  reader: ByteReader,
  write: (data: Buffer) => void,
): Promise<void> {
  write(Buffer.from(RFB_VERSION_3_8, "latin1"));
  const version = (await reader.read(12)).toString("latin1");
  if (version !== RFB_VERSION_3_8) {
    throw new HandshakeError(
      `unexpected client RFB version ${JSON.stringify(version)}`,
    );
  }
  write(Buffer.from([1, SECURITY_NONE]));
  const choice = (await reader.read(1))[0];
  if (choice !== SECURITY_NONE) {
    throw new HandshakeError(`client chose unexpected security type ${choice}`);
  }
  write(Buffer.from([0, 0, 0, 0])); // SecurityResult: OK
}
