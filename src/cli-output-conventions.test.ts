/**
 * NO_COLOR, usage errors and the telemetry toggle's scope, end to end (#230).
 *
 * Runs the built `dist/index.js`. Color needs a terminal, so the color cells
 * preload a module that makes `tty.isatty` answer true for the run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const AS_TERMINAL = "data:text/javascript,import tty from 'node:tty'; tty.isatty = () => true;";
const SGR = /\x1b\[[0-9;]*m/;

let scratch: string;
let server: Server;
let registryUrl: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-conventions-"));
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        packageId: "11111111-2222-3333-4444-555555555555",
        name: "@modelcontextprotocol/server-filesystem",
        packageType: "mcp_server",
        trustLevel: 3,
        trustScore: 0.79,
        verdict: "passed",
        scanStatus: "warnings",
        communityScans: 3,
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

function run(
  args: string[],
  opts: { env?: Record<string, string>; terminal?: boolean } = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      TERM: "xterm-256color",
      OPENA2A_TELEMETRY: "off",
      ...opts.env,
    };
    const nodeArgs = opts.terminal ? ["--import", AS_TERMINAL, CLI_PATH] : [CLI_PATH];
    const child = spawn(process.execPath, [...nodeArgs, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ stdout, stderr, status }));
  });
}

describe("NO_COLOR", () => {
  const check = () => ["--registry-url", registryUrl, "check", "server-filesystem", "--no-scan"];

  it("a set, non-empty NO_COLOR prints no color sequence on a terminal; without it the same run is colored", async () => {
    const colored = await run(check(), { terminal: true });
    expect(colored.status).toBe(0);
    expect(colored.stdout).toMatch(SGR);

    const plain = await run(check(), { terminal: true, env: { NO_COLOR: "1" } });
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toMatch(SGR);
    expect(plain.stdout).toContain("@modelcontextprotocol/server-filesystem");

    // An empty NO_COLOR asks for nothing.
    const empty = await run(check(), { terminal: true, env: { NO_COLOR: "" } });
    expect(empty.stdout).toMatch(SGR);
  });
});

describe("usage errors", () => {
  it("check --json with no name prints one JSON object on stdout", async () => {
    const { stdout, stderr, status } = await run(["check", "--json"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: "missing required argument 'name'" });
    expect(stderr).toBe("");
  });

  it("check with no name and no --json keeps the error on stderr", async () => {
    const { stdout, stderr, status } = await run(["check"]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("error: missing required argument 'name'");
  });

  it("an unknown telemetry action is an error on stderr, worded as config contribute words its own", async () => {
    const telemetry = await run(["telemetry", "maybe"]);
    expect(telemetry.status).toBe(1);
    expect(telemetry.stdout).toBe("");
    expect(telemetry.stderr.trim()).toBe("Error: Unknown action 'maybe'. Use: ai-trust telemetry on | off | status");

    const config = await run(["config", "contribute", "maybe"]);
    expect(config.status).toBe(1);
    expect(config.stdout).toBe("");
    expect(config.stderr.trim()).toBe(
      "Error: Unknown action 'maybe'. Use: ai-trust config contribute on | off | status",
    );
  });
});

describe("telemetry on and off", () => {
  it("name every tool that reads the saved choice", async () => {
    const off = await run(["telemetry", "off"], { env: { OPENA2A_TELEMETRY: "" } });
    expect(off.stdout.split("\n")[0]).toBe(
      "Telemetry disabled for ai-trust and hackmyagent, which share the config file below.",
    );
    expect(off.stdout).toContain(join(scratch, "opena2a", "telemetry.json"));
  });
});
