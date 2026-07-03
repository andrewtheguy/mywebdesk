import crypto from "node:crypto";

function reverseBits(byte: number): number {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    result = (result << 1) | ((byte >> i) & 1);
  }
  return result;
}

// Standard VNC authentication: DES-ECB over the 16-byte challenge, keyed by
// the first 8 bytes of the password (zero-padded) with the bit order of each
// key byte reversed, per the RFB spec's non-standard DES key convention.
export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16) {
    throw new Error(
      `VNC auth challenge must be 16 bytes, got ${challenge.length}`,
    );
  }
  const passwordBytes = Buffer.from(password, "latin1");
  const key = Buffer.alloc(8);
  for (let i = 0; i < Math.min(8, passwordBytes.length); i += 1) {
    key[i] = reverseBits(passwordBytes[i]);
  }
  const cipher = crypto.createCipheriv("des-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
