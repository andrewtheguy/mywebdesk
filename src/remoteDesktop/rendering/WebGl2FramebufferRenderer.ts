type RenderAction =
  | { type: "flip" }
  | {
      type: "copy";
      oldX: number;
      oldY: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      type: "fill";
      x: number;
      y: number;
      width: number;
      height: number;
      color: number[] | Uint8Array;
    }
  | {
      type: "blit";
      data: Uint8Array;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      type: "image";
      image: HTMLImageElement;
      x: number;
      y: number;
      width: number;
      height: number;
    };

declare global {
  interface HTMLImageElement {
    _remoteDisplay?: WebGl2FramebufferRenderer;
  }
}

const VERTEX_SHADER = `#version 300 es
out vec2 texturePosition;

const vec2 positions[3] = vec2[3](
  vec2(-1.0, 3.0),
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0)
);

void main() {
  vec2 position = positions[gl_VertexID];
  gl_Position = vec4(position, 0.0, 1.0);
  texturePosition = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform sampler2D framebufferTexture;
in vec2 texturePosition;
out vec4 outputColor;

void main() {
  outputColor = texture(framebufferTexture, texturePosition);
}
`;

const REQUIRED_WEBGL2_CONTEXT_ATTRIBUTES = {
  alpha: false,
  antialias: false,
  depth: false,
  failIfMajorPerformanceCaveat: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false,
  stencil: false,
} as const satisfies WebGLContextAttributes;

export function getRequiredWebGl2Context(
  canvas: HTMLCanvasElement,
): WebGL2RenderingContext | null {
  return canvas.getContext(
    "webgl2",
    REQUIRED_WEBGL2_CONTEXT_ATTRIBUTES,
  ) as WebGL2RenderingContext | null;
}

export function isWebGl2RendererSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = getRequiredWebGl2Context(canvas);
    if (!gl) {
      return false;
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("WebGL2 could not allocate a shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const details = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${details}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("WebGL2 could not allocate a shader program");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const details = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`WebGL2 shader linking failed: ${details}`);
  }
  return program;
}

function activateProgram(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): void {
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook.
  gl.useProgram(program);
}

interface FramebufferTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

function createFramebufferTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): FramebufferTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    throw new Error("WebGL2 could not allocate the remote framebuffer");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new Error("WebGL2 remote framebuffer is incomplete");
  }

  return { framebuffer, texture };
}

export default class WebGl2FramebufferRenderer {
  readonly #target: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #vertexArray: WebGLVertexArrayObject;
  #framebufferTarget: FramebufferTarget | null = null;
  #copyTarget: FramebufferTarget | null = null;
  #copyWidth = 0;
  #copyHeight = 0;
  #renderQueue: RenderAction[] = [];
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;
  #fbWidth = 0;
  #fbHeight = 0;
  #scale = 1;
  #disposed = false;

  constructor(target: HTMLCanvasElement) {
    this.#target = target;
    const gl = getRequiredWebGl2Context(target);
    if (!gl) {
      throw new Error(
        "WebGL2 is required but unavailable or hardware acceleration is disabled",
      );
    }
    this.#gl = gl;
    this.#program = createProgram(gl);

    const vertexArray = gl.createVertexArray();
    if (!vertexArray) {
      throw new Error("WebGL2 could not allocate a vertex array");
    }
    this.#vertexArray = vertexArray;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    activateProgram(gl, this.#program);
    gl.uniform1i(gl.getUniformLocation(this.#program, "framebufferTexture"), 0);
    gl.bindVertexArray(this.#vertexArray);
  }

  get scale(): number {
    return this.#scale;
  }

  set scale(scale: number) {
    this.#rescale(scale);
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid framebuffer size ${width}x${height}`);
    }
    if (width === this.#fbWidth && height === this.#fbHeight) {
      return;
    }

    const gl = this.#gl;
    const previousTarget = this.#framebufferTarget;
    const previousWidth = this.#fbWidth;
    const previousHeight = this.#fbHeight;
    const nextTarget = createFramebufferTarget(gl, width, height);

    if (previousTarget && previousWidth > 0 && previousHeight > 0) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousTarget.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, nextTarget.framebuffer);
      const copyWidth = Math.min(previousWidth, width);
      const copyHeight = Math.min(previousHeight, height);
      gl.blitFramebuffer(
        0,
        0,
        copyWidth,
        copyHeight,
        0,
        0,
        copyWidth,
        copyHeight,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.deleteFramebuffer(previousTarget.framebuffer);
      gl.deleteTexture(previousTarget.texture);
    }

    this.#framebufferTarget = nextTarget;
    this.#fbWidth = width;
    this.#fbHeight = height;
    this.#target.width = width;
    this.#target.height = height;
    this.#rescale(this.#scale);
    this.flip();
  }

  flip(fromQueue = false): void {
    if (this.#renderQueue.length !== 0 && !fromQueue) {
      this.#pushRenderAction({ type: "flip" });
      return;
    }
    if (!this.#framebufferTarget || this.#gl.isContextLost()) {
      return;
    }

    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.#target.width, this.#target.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#framebufferTarget.texture);
    activateProgram(gl, this.#program);
    gl.bindVertexArray(this.#vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  pending(): boolean {
    return this.#renderQueue.length > 0;
  }

  flush(): Promise<void> {
    if (this.#renderQueue.length === 0) {
      return Promise.resolve();
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise((resolve) => {
        this.#flushResolve = resolve;
      });
    }
    return this.#flushPromise;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    for (const action of this.#renderQueue) {
      if (action.type === "image") {
        action.image.removeEventListener("load", this._resumeRenderQueue);
        action.image.removeEventListener("error", this._resumeRenderQueue);
        URL.revokeObjectURL(action.image.src);
        action.image.src = "";
      }
    }
    this.#renderQueue = [];
    this.#flushResolve?.();
    this.#flushPromise = null;
    this.#flushResolve = null;

    if (this.#framebufferTarget) {
      this.#gl.deleteFramebuffer(this.#framebufferTarget.framebuffer);
      this.#gl.deleteTexture(this.#framebufferTarget.texture);
      this.#framebufferTarget = null;
    }
    if (this.#copyTarget) {
      this.#gl.deleteFramebuffer(this.#copyTarget.framebuffer);
      this.#gl.deleteTexture(this.#copyTarget.texture);
      this.#copyTarget = null;
    }
    this.#gl.deleteVertexArray(this.#vertexArray);
    this.#gl.deleteProgram(this.#program);
  }

  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number[] | Uint8Array,
    fromQueue = false,
  ): void {
    if (this.#renderQueue.length !== 0 && !fromQueue) {
      this.#pushRenderAction({ type: "fill", x, y, width, height, color });
      return;
    }

    const framebufferTarget = this.#requireFramebuffer();
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferTarget.framebuffer);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, width, height);
    gl.clearColor(
      (color[0] ?? 0) / 255,
      (color[1] ?? 0) / 255,
      (color[2] ?? 0) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  copyImage(
    oldX: number,
    oldY: number,
    newX: number,
    newY: number,
    width: number,
    height: number,
    fromQueue = false,
  ): void {
    if (this.#renderQueue.length !== 0 && !fromQueue) {
      this.#pushRenderAction({
        type: "copy",
        oldX,
        oldY,
        x: newX,
        y: newY,
        width,
        height,
      });
      return;
    }

    const gl = this.#gl;
    const framebufferTarget = this.#requireFramebuffer();
    const scratch = this.#requireCopyTarget(width, height);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebufferTarget.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scratch.framebuffer);
    gl.blitFramebuffer(
      oldX,
      oldY,
      oldX + width,
      oldY + height,
      0,
      0,
      width,
      height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scratch.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebufferTarget.framebuffer);
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      newX,
      newY,
      newX + width,
      newY + height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }

  imageRect(
    x: number,
    y: number,
    width: number,
    height: number,
    mime: string,
    data: Uint8Array,
  ): void {
    if (width === 0 || height === 0) {
      return;
    }

    const imageBytes = new Uint8Array(data.byteLength);
    imageBytes.set(data);
    const image = new Image();
    image.src = URL.createObjectURL(
      new Blob([imageBytes.buffer], { type: mime }),
    );
    this.#pushRenderAction({ type: "image", image, x, y, width, height });
  }

  blitImage(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Uint8Array,
    offset: number,
    fromQueue = false,
  ): void {
    if (this.#renderQueue.length !== 0 && !fromQueue) {
      const queuedData = data.slice(offset, offset + width * height * 4);
      this.#pushRenderAction({
        type: "blit",
        data: queuedData,
        x,
        y,
        width,
        height,
      });
      return;
    }

    const framebufferTarget = this.#requireFramebuffer();
    const pixels = data.subarray(offset, offset + width * height * 4);
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, framebufferTarget.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
  }

  #uploadImage(
    image: HTMLImageElement,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (image.naturalWidth !== width || image.naturalHeight !== height) {
      throw new Error(
        `Decoded image is ${image.naturalWidth}x${image.naturalHeight}; expected ${width}x${height}`,
      );
    }
    const framebufferTarget = this.#requireFramebuffer();
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, framebufferTarget.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  #rescale(factor: number): void {
    this.#scale = factor;
    const width = `${factor * this.#fbWidth}px`;
    const height = `${factor * this.#fbHeight}px`;
    if (
      this.#target.style.width !== width ||
      this.#target.style.height !== height
    ) {
      this.#target.style.width = width;
      this.#target.style.height = height;
    }
  }

  #requireFramebuffer(): FramebufferTarget {
    if (this.#disposed) {
      throw new Error("WebGL2 renderer has been disposed");
    }
    if (!this.#framebufferTarget) {
      throw new Error("Remote framebuffer has not been initialized");
    }
    if (this.#gl.isContextLost()) {
      throw new Error("WebGL2 context was lost");
    }
    return this.#framebufferTarget;
  }

  #requireCopyTarget(width: number, height: number): FramebufferTarget {
    if (
      this.#copyTarget &&
      this.#copyWidth >= width &&
      this.#copyHeight >= height
    ) {
      return this.#copyTarget;
    }

    if (this.#copyTarget) {
      this.#gl.deleteFramebuffer(this.#copyTarget.framebuffer);
      this.#gl.deleteTexture(this.#copyTarget.texture);
    }
    this.#copyWidth = Math.max(width, this.#copyWidth);
    this.#copyHeight = Math.max(height, this.#copyHeight);
    this.#copyTarget = createFramebufferTarget(
      this.#gl,
      this.#copyWidth,
      this.#copyHeight,
    );
    return this.#copyTarget;
  }

  #pushRenderAction(action: RenderAction): void {
    this.#renderQueue.push(action);
    if (this.#renderQueue.length === 1) {
      this.#scanRenderQueue();
    }
  }

  _resumeRenderQueue(this: HTMLImageElement): void {
    const display = this._remoteDisplay;
    if (!display) {
      return;
    }
    this.removeEventListener("load", display._resumeRenderQueue);
    this.removeEventListener("error", display._resumeRenderQueue);
    display.#scanRenderQueue();
  }

  #scanRenderQueue(): void {
    let ready = true;
    while (ready && this.#renderQueue.length > 0) {
      const action = this.#renderQueue[0];
      switch (action.type) {
        case "flip":
          this.flip(true);
          break;
        case "copy":
          this.copyImage(
            action.oldX,
            action.oldY,
            action.x,
            action.y,
            action.width,
            action.height,
            true,
          );
          break;
        case "fill":
          this.fillRect(
            action.x,
            action.y,
            action.width,
            action.height,
            action.color,
            true,
          );
          break;
        case "blit":
          this.blitImage(
            action.x,
            action.y,
            action.width,
            action.height,
            action.data,
            0,
            true,
          );
          break;
        case "image":
          if (action.image.complete) {
            try {
              this.#uploadImage(
                action.image,
                action.x,
                action.y,
                action.width,
                action.height,
              );
            } catch (cause) {
              this.#target.dispatchEvent(
                new CustomEvent("renderererror", {
                  detail: {
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to upload a decoded image to WebGL2",
                  },
                }),
              );
            } finally {
              URL.revokeObjectURL(action.image.src);
              action.image.src = "";
            }
          } else {
            action.image._remoteDisplay = this;
            action.image.addEventListener("load", this._resumeRenderQueue);
            action.image.addEventListener("error", this._resumeRenderQueue);
            ready = false;
          }
          break;
      }

      if (ready) {
        this.#renderQueue.shift();
      }
    }

    if (this.#renderQueue.length === 0 && this.#flushPromise) {
      this.#flushResolve?.();
      this.#flushPromise = null;
      this.#flushResolve = null;
    }
  }
}
