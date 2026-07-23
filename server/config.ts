import os from "node:os";
import path from "node:path";

export interface VncTarget {
  name: string;
  host: string;
  port: number;
  password: string;
}

export interface RemotexConfig {
  host: string;
  port: number;
  sitePasswd: string;
  targets: VncTarget[];
}

export interface CliOptions {
  configPath?: string;
  host?: string;
  port?: number;
  help: boolean;
  version: boolean;
}

export const USAGE = `remotex — browser-based VNC viewer

Usage: remotex [options]

Options:
  -c, --config <path>  TOML config file
                       (default: ./remotex.toml, else ~/.config/remotex/config.toml)
      --host <addr>    Listen address (overrides [server].host)
  -p, --port <port>    Listen port (overrides [server].port)
  -v, --version        Print version and exit
  -h, --help           Print this help and exit`;

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 18890;

export function defaultConfigPaths(): string[] {
  return [
    path.resolve("remotex.toml"),
    path.join(os.homedir(), ".config", "remotex", "config.toml"),
  ];
}

export function parseCliArgs(argv: string[]): CliOptions {
  const cli: CliOptions = { help: false, version: false };

  const takeValue = (
    flag: string,
    inline: string | null,
    i: number,
  ): string => {
    if (inline !== null) return inline;
    const next = argv[i + 1];
    if (next === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const consumedNext = inline === null;

    switch (flag) {
      case "-h":
      case "--help":
        cli.help = true;
        break;
      case "-v":
      case "--version":
        cli.version = true;
        break;
      case "-c":
      case "--config":
        cli.configPath = takeValue(flag, inline, i);
        if (consumedNext) i++;
        break;
      case "--host":
        cli.host = takeValue(flag, inline, i);
        if (consumedNext) i++;
        break;
      case "-p":
      case "--port":
        cli.port = parsePortValue(takeValue(flag, inline, i), flag);
        if (consumedNext) i++;
        break;
      default:
        throw new Error(`Unknown argument: ${raw}`);
    }
  }

  return cli;
}

function parsePortValue(raw: string, label: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${label} must be an integer between 1 and 65535, got "${raw}"`,
    );
  }
  return port;
}

function asTable(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asPort(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

export function parseConfigToml(text: string): RemotexConfig {
  let root: unknown;
  try {
    root = Bun.TOML.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const doc = asTable(root, "config");

  const server =
    doc.server === undefined ? {} : asTable(doc.server, "[server]");
  const host =
    server.host === undefined
      ? DEFAULT_LISTEN_HOST
      : asNonEmptyString(server.host, "[server].host");
  const port =
    server.port === undefined
      ? DEFAULT_LISTEN_PORT
      : asPort(server.port, "[server].port");
  const sitePasswd = asNonEmptyString(
    server.site_passwd,
    "[server].site_passwd",
  );

  if (!Array.isArray(doc.targets) || doc.targets.length === 0) {
    throw new Error("At least one [[targets]] entry is required");
  }

  const targets: VncTarget[] = doc.targets.map((entry, index) => {
    const t = asTable(entry, `[[targets]] #${index + 1}`);
    const name = asNonEmptyString(t.name, `[[targets]] #${index + 1} name`);
    if (t.password !== undefined && typeof t.password !== "string") {
      throw new Error(`target "${name}" password must be a string`);
    }
    return {
      name,
      host: asNonEmptyString(t.host, `target "${name}" host`),
      port: asPort(t.port, `target "${name}" port`),
      password: t.password ?? "",
    };
  });

  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.name)) {
      throw new Error(`Duplicate target name "${target.name}"`);
    }
    seen.add(target.name);
  }

  return { host, port, sitePasswd, targets };
}

export async function loadConfig(cli: CliOptions): Promise<RemotexConfig> {
  let configPath: string;
  if (cli.configPath) {
    configPath = path.resolve(cli.configPath);
    if (!(await Bun.file(configPath).exists())) {
      throw new Error(`Config file not found: ${configPath}`);
    }
  } else {
    const candidates = defaultConfigPaths();
    const found = [];
    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) {
        found.push(candidate);
      }
    }
    if (found.length === 0) {
      throw new Error(
        `No config file found (looked for ${candidates.join(", ")}); pass one with --config`,
      );
    }
    configPath = found[0];
  }

  let config: RemotexConfig;
  try {
    config = parseConfigToml(await Bun.file(configPath).text());
  } catch (err) {
    throw new Error(
      `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (cli.host !== undefined) config.host = cli.host;
  if (cli.port !== undefined) config.port = cli.port;
  return config;
}
