import { describe, expect, test } from "bun:test";
import { parseCliArgs, parseConfigToml } from "./config.js";

const FULL_CONFIG = `
[server]
host = "0.0.0.0"
port = 9000
site_passwd = "abc"

[[targets]]
name = "office"
host = "10.0.0.1"
port = 5900
password = "secret"

[[targets]]
name = "home"
host = "10.0.0.2"
port = 5901
`;

describe("parseConfigToml", () => {
  test("parses a full config", () => {
    const config = parseConfigToml(FULL_CONFIG);
    expect(config).toEqual({
      host: "0.0.0.0",
      port: 9000,
      sitePasswd: "abc",
      targets: [
        { name: "office", host: "10.0.0.1", port: 5900, password: "secret" },
        { name: "home", host: "10.0.0.2", port: 5901, password: "" },
      ],
    });
  });

  test("applies server defaults", () => {
    const config = parseConfigToml(`
[server]
site_passwd = "abc"

[[targets]]
name = "a"
host = "h"
port = 5900
`);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(18890);
  });

  test("requires site_passwd", () => {
    expect(() =>
      parseConfigToml(`
[[targets]]
name = "a"
host = "h"
port = 5900
`),
    ).toThrow("[server].site_passwd");
  });

  test("requires at least one target", () => {
    expect(() =>
      parseConfigToml(`
[server]
site_passwd = "abc"
`),
    ).toThrow("At least one [[targets]] entry is required");
  });

  test("rejects duplicate target names", () => {
    expect(() =>
      parseConfigToml(`
[server]
site_passwd = "abc"

[[targets]]
name = "a"
host = "h"
port = 5900

[[targets]]
name = "a"
host = "h2"
port = 5901
`),
    ).toThrow('Duplicate target name "a"');
  });

  test("rejects invalid target port", () => {
    expect(() =>
      parseConfigToml(`
[server]
site_passwd = "abc"

[[targets]]
name = "a"
host = "h"
port = 99999
`),
    ).toThrow('target "a" port');
  });

  test("rejects missing target host", () => {
    expect(() =>
      parseConfigToml(`
[server]
site_passwd = "abc"

[[targets]]
name = "a"
port = 5900
`),
    ).toThrow('target "a" host');
  });

  test("rejects invalid TOML", () => {
    expect(() => parseConfigToml("not = [valid")).toThrow("Invalid TOML");
  });
});

describe("parseCliArgs", () => {
  test("parses flags", () => {
    expect(
      parseCliArgs([
        "--config",
        "/tmp/c.toml",
        "--host",
        "0.0.0.0",
        "-p",
        "8080",
      ]),
    ).toEqual({
      configPath: "/tmp/c.toml",
      host: "0.0.0.0",
      port: 8080,
      help: false,
      version: false,
    });
  });

  test("parses --flag=value form", () => {
    const cli = parseCliArgs(["--config=/tmp/c.toml", "--port=8080"]);
    expect(cli.configPath).toBe("/tmp/c.toml");
    expect(cli.port).toBe(8080);
  });

  test("parses help and version", () => {
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["-v"]).version).toBe(true);
  });

  test("rejects unknown arguments", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(
      "Unknown argument: --bogus",
    );
  });

  test("rejects missing values", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(
      "Missing value for --config",
    );
  });

  test("rejects invalid port", () => {
    expect(() => parseCliArgs(["--port", "abc"])).toThrow("--port");
    expect(() => parseCliArgs(["-p", "0"])).toThrow("-p");
  });
});
