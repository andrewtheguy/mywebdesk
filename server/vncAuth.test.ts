import { expect, test } from "bun:test";
// noVNC's DES implementation (VNC key-bit convention baked in) as an
// independent reference for our node:crypto-based implementation.
// @ts-expect-error - no type declarations for the vendored noVNC module
import { DESECBCipher } from "../src/vendor/novnc/core/crypto/des.js";
import { vncAuthResponse } from "./vncAuth";

function referenceResponse(password: string, challenge: Buffer): Buffer {
  const passwordChars = password.split("").map((c) => c.charCodeAt(0));
  const cipher = DESECBCipher.importKey(passwordChars, null, false, []);
  const out = cipher.encrypt(null, new Uint8Array(challenge));
  return Buffer.from(out);
}

test("matches noVNC's DES for a typical password", () => {
  const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  expect(vncAuthResponse("qwertasdfg", challenge)).toEqual(
    referenceResponse("qwertasdfg", challenge),
  );
});

test("matches noVNC's DES for short passwords (zero-padded key)", () => {
  const challenge = Buffer.from("fedcba98765432100123456789abcdef", "hex");
  expect(vncAuthResponse("abc", challenge)).toEqual(
    referenceResponse("abc", challenge),
  );
});

test("uses only the first 8 password bytes", () => {
  const challenge = Buffer.alloc(16, 0x5a);
  expect(vncAuthResponse("12345678ignored", challenge)).toEqual(
    vncAuthResponse("12345678", challenge),
  );
});

test("rejects malformed challenges", () => {
  expect(() => vncAuthResponse("pw", Buffer.alloc(8))).toThrow();
});
