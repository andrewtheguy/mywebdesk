// Out-of-band display resize for VNC servers that don't support the RFB
// SetDesktopSize extension (macOS Screen Sharing). The remotex server SSHes
// into the VNC target and runs the `displaymode` helper (tools/
// displaymode.swift, compiled on the target), which switches the display to
// the largest mode that fits the requested size. The framebuffer change then
// propagates back to the client through the normal VNC desktop-size update.
//
// Enabled by setting DISPLAY_RESIZE_SSH (e.g. "andrew@10.22.38.133").

const SSH_TARGET = process.env.DISPLAY_RESIZE_SSH || "";
const REMOTE_CMD = process.env.DISPLAY_RESIZE_CMD || "~/.local/bin/displaymode";

const MIN_DIMENSION = 320;
const MAX_DIMENSION = 8192;

export const displayResizeEnabled = SSH_TARGET.length > 0;

interface ResizeTarget {
  width: number;
  height: number;
}

let pendingTarget: ResizeTarget | null = null;
let lastAppliedTarget: ResizeTarget | null = null;
let running = false;

// Accepts a resize request and kicks the (serialized) SSH runner. Returns
// false when the dimensions are invalid or resize is not configured.
export function requestDisplayResize(width: unknown, height: unknown): boolean {
  if (!displayResizeEnabled) return false;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height < MIN_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    return false;
  }

  pendingTarget = { width, height };
  void run();
  return true;
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pendingTarget) {
      const target = pendingTarget;
      pendingTarget = null;
      if (
        lastAppliedTarget &&
        lastAppliedTarget.width === target.width &&
        lastAppliedTarget.height === target.height
      ) {
        continue;
      }
      await applyTarget(target);
    }
  } finally {
    running = false;
  }
}

async function applyTarget(target: ResizeTarget): Promise<void> {
  // Dimensions are validated integers, so the remote command is safe to
  // compose as a string.
  const proc = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      SSH_TARGET,
      `${REMOTE_CMD} set ${target.width} ${target.height}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (exitCode === 0) {
    lastAppliedTarget = target;
    console.log(
      `[display-resize] ${target.width}x${target.height} -> ${stdout}`,
    );
  } else {
    // Leave lastAppliedTarget unset so the next request retries.
    lastAppliedTarget = null;
    console.error(
      `[display-resize] failed (exit ${exitCode}): ${stderr || stdout}`,
    );
  }
}
