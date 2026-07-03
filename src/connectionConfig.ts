export interface ConnectionConfig {
  host: string;
  port: string;
  vncPassword: string;
}

// Validates the /api/app/config response shape; throws with a clear message
// on malformed payloads.
export function parseConnectionConfig(payload: unknown): ConnectionConfig {
  if (!payload || typeof payload !== "object") {
    console.error("Invalid /api/config payload (expected object):", payload);
    throw new Error("Invalid config response: expected object payload");
  }

  const { host, port, vncPassword } = payload as {
    host?: unknown;
    port?: unknown;
    vncPassword?: unknown;
  };

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

  return {
    host: host.trim(),
    port: normalizedPort,
    vncPassword: typeof vncPassword === "string" ? vncPassword : "",
  };
}
