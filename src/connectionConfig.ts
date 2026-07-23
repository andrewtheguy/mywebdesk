export interface VncTargetInfo {
  name: string;
  host: string;
  port: string;
}

// Validates the /api/app/config response shape; throws with a clear message
// on malformed payloads.
export function parseConnectionTargets(payload: unknown): VncTargetInfo[] {
  if (!payload || typeof payload !== "object") {
    console.error("Invalid /api/config payload (expected object):", payload);
    throw new Error("Invalid config response: expected object payload");
  }

  const { targets } = payload as { targets?: unknown };
  if (!Array.isArray(targets) || targets.length === 0) {
    console.error("Invalid /api/config payload (targets):", payload);
    throw new Error(
      "Invalid config response: targets must be a non-empty array",
    );
  }

  return targets.map((entry) => {
    if (!entry || typeof entry !== "object") {
      console.error("Invalid /api/config payload (target entry):", entry);
      throw new Error("Invalid config response: each target must be an object");
    }

    const { name, host, port } = entry as {
      name?: unknown;
      host?: unknown;
      port?: unknown;
    };

    if (typeof name !== "string" || name.trim().length === 0) {
      console.error("Invalid /api/config payload (name):", entry);
      throw new Error(
        "Invalid config response: target name must be a non-empty string",
      );
    }

    if (typeof host !== "string" || host.trim().length === 0) {
      console.error("Invalid /api/config payload (host):", entry);
      throw new Error(
        "Invalid config response: target host must be a non-empty string",
      );
    }

    let normalizedPort: string;
    if (typeof port === "number" && Number.isFinite(port)) {
      normalizedPort = String(port);
    } else if (typeof port === "string" && port.trim().length > 0) {
      normalizedPort = port.trim();
    } else {
      console.error("Invalid /api/config payload (port):", entry);
      throw new Error(
        "Invalid config response: target port must be a non-empty string or number",
      );
    }

    return {
      name: name.trim(),
      host: host.trim(),
      port: normalizedPort,
    };
  });
}
