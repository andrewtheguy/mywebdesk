import { expect, test } from "bun:test";
import Deflator from "./vendor/novnc/core/deflator";
import Inflator from "./vendor/novnc/core/inflator";

test("noVNC compression wrappers round-trip a zlib payload", () => {
  const input = new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 254, 253, 252,
  ]);

  const compressed = new Deflator().deflate(input);
  const inflator = new Inflator();
  inflator.setInput(compressed);

  expect(Array.from(inflator.inflate(input.length))).toEqual(Array.from(input));
});

test("noVNC inflator supports sequential reads from one zlib stream", () => {
  const first = new Uint8Array([0, 0, 0, 5]);
  const second = new Uint8Array([104, 101, 108, 108, 111]);
  const input = new Uint8Array(first.length + second.length);
  input.set(first);
  input.set(second, first.length);

  const compressed = new Deflator().deflate(input);
  const inflator = new Inflator();
  inflator.setInput(compressed);

  expect(Array.from(inflator.inflate(first.length))).toEqual(Array.from(first));
  expect(Array.from(inflator.inflate(second.length))).toEqual(
    Array.from(second),
  );
});

test("noVNC inflator reset starts a new zlib stream", () => {
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([5, 6, 7, 8]);
  const inflator = new Inflator();

  inflator.setInput(new Deflator().deflate(first));
  expect(Array.from(inflator.inflate(first.length))).toEqual(Array.from(first));

  inflator.reset();
  inflator.setInput(new Deflator().deflate(second));
  expect(Array.from(inflator.inflate(second.length))).toEqual(
    Array.from(second),
  );
});
