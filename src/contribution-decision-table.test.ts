/**
 * Whether `check` and `audit` share a scan, for every flag, saved choice,
 * stdin and CI setting.
 *
 * Each cell runs the built `dist/index.js` with its own HOME against one
 * local server that plays both registries, so nothing leaves the machine:
 * the npm registry `npm pack` downloads the package from, and the trust
 * registry, which has no data for the package (so both commands scan it) and
 * captures every request sent to it. `check` scans the package by name;
 * `audit` scans it from a package.json with `--scan-missing`.
 *
 * Inputs: the flag (`--contribute`, `--no-contribute`, none); the saved
 * choice in ~/.opena2a/config.json (no file, `true`, `false`, `"true"`,
 * `"false"`, a file that is not JSON), each value saved with a `decidedAt`
 * as `ai-trust config contribute` saves one; stdin a terminal or not; CI set
 * or unset. Both commands ask `process.stdin.isTTY` whether stdin is a
 * terminal, so a terminal is a preload that sets it, and a prompt is
 * answered "y".
 *
 * Per cell: whether a prompt appeared, the events that reached the registry,
 * the config file after the run, and the lines printed about sharing (stderr
 * without the scan progress lines).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const PACKAGE = "decision-table-fixture-pkg";
/** The time every seeded config value carries; any other time was written by the run. */
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

type CommandName = "check" | "audit";
type Flag = "--contribute" | "--no-contribute" | "none";
type Saved = "absent" | "true" | "false" | '"true"' | '"false"' | "invalid";
type Stdin = "terminal" | "pipe";
type Ci = "CI" | "no CI";

const COMMANDS: CommandName[] = ["check", "audit"];
const FLAGS: Flag[] = ["--contribute", "--no-contribute", "none"];
const SAVED: Saved[] = ["absent", "true", "false", '"true"', '"false"', "invalid"];
const STDINS: Stdin[] = ["terminal", "pipe"];
const CIS: Ci[] = ["CI", "no CI"];

interface Observed {
  /** A yes/no question appeared. */
  prompt: boolean;
  /** Event types and requests that reached the registry, sorted. */
  sent: string[];
  /** The config file after the run (times other than SEEDED_AT read <run>), or null when there is none. */
  config: string | null;
  /** stderr lines about sharing: no blank lines, no scan progress lines. */
  lines: string[];
}

interface Cell {
  command: CommandName;
  flag: Flag;
  saved: Saved;
  stdin: Stdin;
  ci: Ci;
}

function cellKey(c: Cell): string {
  return `${c.command} | ${c.flag} | saved ${c.saved} | ${c.stdin} | ${c.ci}`;
}

const CELLS: Cell[] = [];
for (const command of COMMANDS)
  for (const flag of FLAGS)
    for (const saved of SAVED)
      for (const stdin of STDINS)
        for (const ci of CIS) CELLS.push({ command, flag, saved, stdin, ci });

function savedFile(saved: Saved): string | null {
  switch (saved) {
    case "absent":
      return null;
    case "invalid":
      return '{"contribute":';
    default:
      return `{"contribute":{"enabled":${saved},"decidedAt":"${SEEDED_AT}"}}\n`;
  }
}

let scratch: string;
let server: Server;
let baseUrl: string;
let tarballName: string;
let tarball: Buffer;
let manifestPath: string;
let ttyPreload: string;
/** Requests to the trust registry, by cell prefix. */
const captured = new Map<string, string[]>();
const observed = new Map<string, Observed>();

function startServer(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // npm registry: packument and tarball.
    if (req.method === "GET" && url.pathname === `/${PACKAGE}`) {
      return send(200, {
        name: PACKAGE,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: PACKAGE,
            version: "1.0.0",
            dist: {
              tarball: `${baseUrl}/${PACKAGE}/-/${tarballName}`,
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            },
          },
        },
      });
    }
    if (req.method === "GET" && url.pathname === `/${PACKAGE}/-/${tarballName}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(tarball);
    }
    // Trust registry, one path prefix per cell: /<cell>/api/v1/...
    const match = /^\/(c\d+)(\/.*)$/.exec(url.pathname);
    const record = (entry: string) => {
      const key = match ? match[1] : "unprefixed";
      captured.set(key, [...(captured.get(key) ?? []), entry]);
    };
    const path = match ? match[2] : url.pathname;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "GET" && path === "/api/v1/trust/query") {
        return send(404, { error: "package not found" });
      }
      if (req.method === "POST" && path === "/api/v1/trust/batch") {
        return send(200, { results: [{ name: PACKAGE, packageId: null }], total: 1 });
      }
      if (req.method === "POST" && path === "/api/v1/contribute") {
        try {
          const events = (JSON.parse(body) as { events?: { type?: string }[] }).events ?? [];
          for (const e of events) record(`contribute ${e.type}`);
        } catch {
          record("contribute (not JSON)");
        }
        return send(200, {});
      }
      if (req.method === "POST" && path === "/api/v1/trust/publish") {
        record("publish");
        return send(200, { accepted: true });
      }
      record(`${req.method} ${path}`);
      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

function cellEnv(home: string, ci: Ci): NodeJS.ProcessEnv {
  // An allow-list: no host config, no consent file, no usage telemetry; npm
  // reads the local registry and keeps its cache in the cell's directory.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    NO_COLOR: "1",
    OPENA2A_TELEMETRY: "off",
    npm_config_registry: baseUrl,
    npm_config_cache: join(home, ".npm"),
    npm_config_update_notifier: "false",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (ci === "CI") env.CI = "true";
  return env;
}

function normalizeConfig(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
    t === SEEDED_AT ? t : "<run>",
  );
}

function sharingLines(stderr: string): string[] {
  return stderr
    // A prompt's question is not followed by a newline: the answer is read
    // from stdin, which is not echoed here.
    .replace(/\[Y\/n\] /g, "[Y/n]\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !/^\s*Scanning\b/.test(l));
}

function runCell(cell: Cell, index: number): Promise<Observed> {
  const prefix = `c${index}`;
  const home = join(scratch, "cells", prefix);
  mkdirSync(join(home, ".opena2a"), { recursive: true });
  const seeded = savedFile(cell.saved);
  const configPath = join(home, ".opena2a", "config.json");
  if (seeded !== null) writeFileSync(configPath, seeded);

  const registryUrl = `${baseUrl}/${prefix}`;
  const flagArgs = cell.flag === "none" ? [] : [cell.flag];
  const commandArgs =
    cell.command === "check"
      ? ["check", PACKAGE, "--no-deep"]
      : ["audit", manifestPath, "--scan-missing", "--no-deep"];
  const nodeArgs = cell.stdin === "terminal" ? ["--require", ttyPreload] : [];

  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [...nodeArgs, CLI_PATH, ...commandArgs, ...flagArgs, "--json", "--registry-url", registryUrl],
      { cwd: home, env: cellEnv(home, cell.ci), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => {
      // The scan ran: stdout is the scan's JSON.
      if (!stdout.trim().startsWith("{") && !stdout.trim().startsWith("[")) {
        reject(new Error(`${cellKey(cell)}: no JSON on stdout\n${stdout}\n${stderr}`));
        return;
      }
      resolveRun({
        prompt: /\[Y\/n\]/.test(stderr),
        sent: [...(captured.get(prefix) ?? [])].sort(),
        config: existsSync(configPath) ? normalizeConfig(readFileSync(configPath, "utf-8")) : null,
        lines: sharingLines(stderr),
      });
    });
    // The answer to a prompt; read only when a prompt asks for it.
    child.stdin.end("y\n");
  });
}

async function runAll(concurrency: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < CELLS.length) {
      const index = next++;
      observed.set(cellKey(CELLS[index]), await runCell(CELLS[index], index));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

beforeAll(async () => {
  if (!existsSync(CLI_PATH)) return;
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-decision-"));
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The package the local npm registry serves, packed from two files.
  const source = join(scratch, "source");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: PACKAGE, version: "1.0.0" }));
  writeFileSync(join(source, "index.js"), "module.exports = 1;\n");
  execFileSync("npm", ["pack", "--pack-destination", scratch], {
    cwd: source,
    env: cellEnv(join(scratch, "pack-home"), "no CI"),
    stdio: "pipe",
  });
  tarballName = readdirSync(scratch).find((f) => f.endsWith(".tgz")) ?? "";
  tarball = readFileSync(join(scratch, tarballName));

  // The dependency file `audit` reads.
  const project = join(scratch, "project");
  mkdirSync(project);
  manifestPath = join(project, "package.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ name: "project", version: "1.0.0", dependencies: { [PACKAGE]: "1.0.0" } }),
  );

  ttyPreload = join(scratch, "stdin-terminal.cjs");
  writeFileSync(ttyPreload, "process.stdin.isTTY = true;\n");

  await runAll(8);
}, 900000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// What reached the registry, as captured.
const NONE: string[] = [];
const PING_AND_PUBLISH = ["contribute scan_ping", "publish"];
const PING_SUMMARY_AND_PUBLISH = ["contribute scan_ping", "contribute scan_result", "publish"];
const SUMMARY_AND_PUBLISH = ["contribute scan_result", "publish"];

// The lines printed about sharing.
const ASKED = [
  "  You just scanned 1 package(s) with no community trust data.",
  "  Sharing pseudonymous results helps other developers make informed decisions.",
  "Share these scans with the community? [Y/n]",
  "  (Future scans will auto-share. Change: ai-trust config contribute off)",
];
const HOW_TO_SHARE = [
  "  1 package(s) scanned for the first time. Share with the community:",
  "    ai-trust audit <file> --scan-missing --contribute",
];

const SEEDED = { decidedAt: SEEDED_AT };
const SAVED_IN_RUN = { consentedAt: "<run>", decidedAt: "<run>" };

/** The config file as @opena2a/shared saves it. */
function sharedFile(
  enabled: unknown,
  scanCount: number,
  marks: { consentedAt?: string; decidedAt?: string } = {},
): string {
  return (
    JSON.stringify(
      {
        version: 1,
        contribute: {
          enabled,
          consentedAt: marks.consentedAt ?? null,
          consentVersion: "1.0",
          ...(marks.decidedAt ? { decidedAt: marks.decidedAt } : {}),
        },
        registry: { url: "" },
        llm: { enabled: false, consentedAt: null, consentVersion: "1.0" },
        preferences: { rememberedChoices: {} },
        telemetry: { scanCount, contributePromptDismissedAt: null },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Observed for each command, flag, saved choice and stdin; CI set or unset
 * gives the same result in every cell. The bundled scanner runs with a home
 * of its own and writes nothing to the config file, so a scan count of 1 is
 * ai-trust's own count, and savedFile(...) is the file as the cell seeded it,
 * which nothing in the run wrote.
 */
type Row = [CommandName, Flag, Saved, Stdin, boolean, string[], string | null, string[]];
const TABLE: Row[] = [
  // command, flag, saved, stdin, prompt, reached the registry, config after, lines
  ["check", "--contribute", "absent", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["check", "--contribute", "absent", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["check", "--contribute", "true", "terminal", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["check", "--contribute", "true", "pipe", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["check", "--contribute", "false", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1, SEEDED), []],
  ["check", "--contribute", "false", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1, SEEDED), []],
  ["check", "--contribute", "\"true\"", "terminal", false, PING_AND_PUBLISH, sharedFile("true", 1, SEEDED), []],
  ["check", "--contribute", "\"true\"", "pipe", false, PING_AND_PUBLISH, sharedFile("true", 1, SEEDED), []],
  ["check", "--contribute", "\"false\"", "terminal", false, PING_AND_PUBLISH, sharedFile("false", 1, SEEDED), []],
  ["check", "--contribute", "\"false\"", "pipe", false, PING_AND_PUBLISH, sharedFile("false", 1, SEEDED), []],
  ["check", "--contribute", "invalid", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["check", "--contribute", "invalid", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["check", "--no-contribute", "absent", "terminal", false, NONE, sharedFile(false, 1), []],
  ["check", "--no-contribute", "absent", "pipe", false, NONE, sharedFile(false, 1), []],
  ["check", "--no-contribute", "true", "terminal", false, NONE, sharedFile(true, 1, SEEDED), []],
  ["check", "--no-contribute", "true", "pipe", false, NONE, sharedFile(true, 1, SEEDED), []],
  ["check", "--no-contribute", "false", "terminal", false, NONE, sharedFile(false, 1, SEEDED), []],
  ["check", "--no-contribute", "false", "pipe", false, NONE, sharedFile(false, 1, SEEDED), []],
  ["check", "--no-contribute", "\"true\"", "terminal", false, NONE, sharedFile("true", 1, SEEDED), []],
  ["check", "--no-contribute", "\"true\"", "pipe", false, NONE, sharedFile("true", 1, SEEDED), []],
  ["check", "--no-contribute", "\"false\"", "terminal", false, NONE, sharedFile("false", 1, SEEDED), []],
  ["check", "--no-contribute", "\"false\"", "pipe", false, NONE, sharedFile("false", 1, SEEDED), []],
  ["check", "--no-contribute", "invalid", "terminal", false, NONE, sharedFile(false, 1), []],
  ["check", "--no-contribute", "invalid", "pipe", false, NONE, sharedFile(false, 1), []],
  ["check", "none", "absent", "terminal", false, NONE, sharedFile(false, 1), []],
  ["check", "none", "absent", "pipe", false, NONE, sharedFile(false, 1), []],
  ["check", "none", "true", "terminal", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["check", "none", "true", "pipe", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["check", "none", "false", "terminal", false, NONE, sharedFile(false, 1, SEEDED), []],
  ["check", "none", "false", "pipe", false, NONE, sharedFile(false, 1, SEEDED), []],
  ["check", "none", "\"true\"", "terminal", false, NONE, sharedFile("true", 1, SEEDED), []],
  ["check", "none", "\"true\"", "pipe", false, NONE, sharedFile("true", 1, SEEDED), []],
  ["check", "none", "\"false\"", "terminal", false, NONE, sharedFile("false", 1, SEEDED), []],
  ["check", "none", "\"false\"", "pipe", false, NONE, sharedFile("false", 1, SEEDED), []],
  ["check", "none", "invalid", "terminal", false, NONE, sharedFile(false, 1), []],
  ["check", "none", "invalid", "pipe", false, NONE, sharedFile(false, 1), []],
  ["audit", "--contribute", "absent", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["audit", "--contribute", "absent", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["audit", "--contribute", "true", "terminal", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["audit", "--contribute", "true", "pipe", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["audit", "--contribute", "false", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1, SEEDED), []],
  ["audit", "--contribute", "false", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1, SEEDED), []],
  ["audit", "--contribute", "\"true\"", "terminal", false, PING_AND_PUBLISH, sharedFile("true", 1, SEEDED), []],
  ["audit", "--contribute", "\"true\"", "pipe", false, PING_AND_PUBLISH, sharedFile("true", 1, SEEDED), []],
  ["audit", "--contribute", "\"false\"", "terminal", false, PING_AND_PUBLISH, sharedFile("false", 1, SEEDED), []],
  ["audit", "--contribute", "\"false\"", "pipe", false, PING_AND_PUBLISH, sharedFile("false", 1, SEEDED), []],
  ["audit", "--contribute", "invalid", "terminal", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["audit", "--contribute", "invalid", "pipe", false, PING_AND_PUBLISH, sharedFile(false, 1), []],
  ["audit", "--no-contribute", "absent", "terminal", false, NONE, savedFile("absent"), []],
  ["audit", "--no-contribute", "absent", "pipe", false, NONE, savedFile("absent"), []],
  ["audit", "--no-contribute", "true", "terminal", false, NONE, savedFile("true"), []],
  ["audit", "--no-contribute", "true", "pipe", false, NONE, savedFile("true"), []],
  ["audit", "--no-contribute", "false", "terminal", false, NONE, savedFile("false"), []],
  ["audit", "--no-contribute", "false", "pipe", false, NONE, savedFile("false"), []],
  ["audit", "--no-contribute", "\"true\"", "terminal", false, NONE, savedFile("\"true\""), []],
  ["audit", "--no-contribute", "\"true\"", "pipe", false, NONE, savedFile("\"true\""), []],
  ["audit", "--no-contribute", "\"false\"", "terminal", false, NONE, savedFile("\"false\""), []],
  ["audit", "--no-contribute", "\"false\"", "pipe", false, NONE, savedFile("\"false\""), []],
  ["audit", "--no-contribute", "invalid", "terminal", false, NONE, savedFile("invalid"), []],
  ["audit", "--no-contribute", "invalid", "pipe", false, NONE, savedFile("invalid"), []],
  ["audit", "none", "absent", "terminal", true, SUMMARY_AND_PUBLISH, sharedFile(true, 1, SAVED_IN_RUN), ASKED],
  ["audit", "none", "absent", "pipe", false, NONE, savedFile("absent"), HOW_TO_SHARE],
  ["audit", "none", "true", "terminal", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["audit", "none", "true", "pipe", false, PING_SUMMARY_AND_PUBLISH, sharedFile(true, 1, SEEDED), []],
  ["audit", "none", "false", "terminal", false, NONE, savedFile("false"), []],
  ["audit", "none", "false", "pipe", false, NONE, savedFile("false"), HOW_TO_SHARE],
  ["audit", "none", "\"true\"", "terminal", true, SUMMARY_AND_PUBLISH, sharedFile(true, 1, SAVED_IN_RUN), ASKED],
  ["audit", "none", "\"true\"", "pipe", false, NONE, savedFile("\"true\""), HOW_TO_SHARE],
  ["audit", "none", "\"false\"", "terminal", true, SUMMARY_AND_PUBLISH, sharedFile(true, 1, SAVED_IN_RUN), ASKED],
  ["audit", "none", "\"false\"", "pipe", false, NONE, savedFile("\"false\""), HOW_TO_SHARE],
  ["audit", "none", "invalid", "terminal", true, SUMMARY_AND_PUBLISH, sharedFile(true, 1, SAVED_IN_RUN), ASKED],
  ["audit", "none", "invalid", "pipe", false, NONE, savedFile("invalid"), HOW_TO_SHARE],
];

function expectedFor(cell: Cell): Observed {
  const row = TABLE.find(
    ([command, flag, saved, stdin]) =>
      command === cell.command && flag === cell.flag && saved === cell.saved && stdin === cell.stdin,
  );
  if (!row) throw new Error(`no row for ${cellKey(cell)}`);
  const [, , , , prompt, sent, config, lines] = row;
  return { prompt, sent, config, lines };
}

/**
 * Where check and audit answer differently for the same inputs: `audit`
 * asks on a terminal and prints how to share when it cannot ask, where
 * `check` never asks and prints nothing; and `check` counts every scan
 * toward the opt-in tip, where `audit` counts only a scan it shares.
 */
function commandsDiffer(flag: Flag, saved: Saved): boolean {
  return flag === "--no-contribute" || (flag === "none" && saved !== "true");
}

describe("contribution decision table", () => {
  it("dist/index.js exists and every cell has a row", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
    expect(TABLE).toHaveLength(CELLS.length / CIS.length);
    for (const cell of CELLS) expect(() => expectedFor(cell)).not.toThrow();
  });

  it.each(CELLS.map((cell) => [cellKey(cell), cell] as const))("%s", (_key, cell) => {
    if (!existsSync(CLI_PATH)) return;
    expect(observed.get(cellKey(cell))).toEqual(expectedFor(cell));
  });

  it("sends nothing outside the per-cell registry paths", () => {
    if (!existsSync(CLI_PATH)) return;
    expect(captured.get("unprefixed")).toBeUndefined();
  });

  it("check and audit differ only where listed", () => {
    if (!existsSync(CLI_PATH)) return;
    for (const cell of CELLS.filter((c) => c.command === "check")) {
      const audit = observed.get(cellKey({ ...cell, command: "audit" }));
      const same = JSON.stringify(observed.get(cellKey(cell))) === JSON.stringify(audit);
      expect({ cell: cellKey(cell), differ: !same }).toEqual({
        cell: cellKey(cell),
        differ: commandsDiffer(cell.flag, cell.saved),
      });
    }
  });
});
