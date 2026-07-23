import { expect, test } from "bun:test";
import { vncAuthResponse } from "./vncAuth";

test("matches a VNC authentication regression vector", () => {
  const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  expect(vncAuthResponse("qwertasdfg", challenge)).toEqual(
    Buffer.from("5b1484f3694badef32e25406e539d72d", "hex"),
  );
});

test("zero-pads a short VNC password", () => {
  const challenge = Buffer.from("fedcba98765432100123456789abcdef", "hex");
  expect(vncAuthResponse("abc", challenge)).toEqual(
    Buffer.from("e1a7650fb69cf1b19fe42e121c0606b0", "hex"),
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
