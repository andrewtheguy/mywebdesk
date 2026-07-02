export interface ConnectionConfig {
  protocol: "vnc" | "rdp";
  host: string;
  port: string;
}

// Validates the /api/app/config response shape; throws with a clear message
// on malformed payloads.
export function parseConnectionConfig(payload: unknown): ConnectionConfig {
  if (!payload || typeof payload !== "object") {
    console.error("Invalid /api/config payload (expected object):", payload);
    throw new Error("Invalid config response: expected object payload");
  }

  const { protocol, host, port } = payload as {
    protocol?: unknown;
    host?: unknown;
    port?: unknown;
  };

  if (protocol !== "vnc" && protocol !== "rdp") {
    console.error("Invalid /api/config payload (protocol):", payload);
    throw new Error('Invalid config response: protocol must be "vnc" or "rdp"');
  }

  if (typeof host !== "string" || host.trim().length === 0) {
    console.error("Invalid /api/config payload (host):", payload);
    throw new Error("Invalid config response: host must be a non-empty string");
  }

  let normalizedPort: string;
  if (typeof port === "number" && Number.isFinite(port)) {
    normalizedPort = String(port);
  } else if (typeof port === "string" && port.trim().length > 0) {
    normalizedPort = port.trim();
  } else {
    console.error("Invalid /api/config payload (port):", payload);
    throw new Error(
      "Invalid config response: port must be a non-empty string or number",
    );
  }

  return { protocol, host: host.trim(), port: normalizedPort };
}
