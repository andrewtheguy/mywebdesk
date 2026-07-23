import { expect, test } from "bun:test";
import { getRequiredWebGl2Context } from "./WebGl2FramebufferRenderer";

test("requests only a high-performance WebGL2 context", () => {
  const context = {} as WebGL2RenderingContext;
  let requestedType: string | undefined;
  let requestedAttributes: WebGLContextAttributes | undefined;
  const canvas = {
    getContext(type: string, attributes: WebGLContextAttributes) {
      requestedType = type;
      requestedAttributes = attributes;
      return context;
    },
  } as unknown as HTMLCanvasElement;

  expect(getRequiredWebGl2Context(canvas)).toBe(context);
  expect(requestedType).toBe("webgl2");
  expect(requestedAttributes).toMatchObject({
    alpha: false,
    antialias: false,
    depth: false,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    stencil: false,
  });
});

test("does not fall back when WebGL2 context creation fails", () => {
  const canvas = {
    getContext() {
      return null;
    },
  } as unknown as HTMLCanvasElement;

  expect(getRequiredWebGl2Context(canvas)).toBeNull();
});
