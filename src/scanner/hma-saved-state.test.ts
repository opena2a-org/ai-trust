/**
 * The bundled scanner neither touches the user's saved choices nor sends
 * anything during an ai-trust run.
 *
 * Runs the built `dist/index.js` with the real pinned hackmyagent in a
 * temporary home, for `check <label> --scan-path <dir>` and for
 * `audit package.json --scan-missing`, over every combination of:
 *   - the contribution value in ~/.opena2a/config.json (absent, true, false,
 *     "true", "false", a file that is not valid JSON);
 *   - ~/.hackmyagent/config.json (absent, `"contribute": true`,
 *     `"contribute": false`);
 *   - `--contribute`, `--no-contribute` or neither;
 *   - `--no-deep` or not.
 * Each run must leave both config files byte-identical, open neither of them
 * from the scanner process, send no request from the scanner process, and run
 * the scanner with `--static-only` under `--no-deep` and `--deep` otherwise.
 * An audit that shares its scans records them in ~/.opena2a/config.json
 * itself, so there the file is compared with what ai-trust's own record
 * leaves in a copy of the starting home.
 *
 * A preload passed through NODE_OPTIONS acts only in the scanner process: it
 * records the scanner's argv and its opening of either config file, and sends
 * each of its requests to the capture server instead of where it was going.
 * Two kinds are left out: a classifier model download, which goes to the
 * local stub and gets a 404 so a deep scan falls back the same way on every
 * run, and loopback requests to other ports (the NanoMind daemon). The
 * endpoints the scanner reads from the environment (REGISTRY_URL,
 * OPENA2A_TELEMETRY_URL) point at the stub as well, so nothing leaves the
 * machine. The stub also plays the trust registry (no data for the audited
 * package, so audit scans it) and the npm registry `npm pack` downloads it
 * from.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
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
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_PATH = resolve(__dirname, "../../dist/index.js");
const OPT_IN_URL = pathToFileURL(resolve(__dirname, "../../dist/telemetry/opt-in.js")).href;
const DECISION_URL = pathToFileURL(resolve(__dirname, "../../dist/telemetry/decision.js")).href;
const PACKAGE = "matrix-fixture-pkg";

const SAVED: { label: string; content: string | null }[] = [
  { label: "absent", content: null },
  { label: "true", content: JSON.stringify({ contribute: { enabled: true } }) },
  { label: "false", content: JSON.stringify({ contribute: { enabled: false } }) },
  { label: '"true"', content: JSON.stringify({ contribute: { enabled: "true" } }) },
  { label: '"false"', content: JSON.stringify({ contribute: { enabled: "false" } }) },
  { label: "invalid JSON", content: '{"contribute": {"enabled": true}' },
];
const LEGACY: { label: string; content: string | null }[] = [
  { label: "absent", content: null },
  { label: '"contribute": true', content: JSON.stringify({ contribute: true }) },
  { label: '"contribute": false', content: JSON.stringify({ contribute: false }) },
];
const FLAGS = ["--contribute", "--no-contribute", null] as const;

interface Cell {
  command: "check" | "audit";
  saved: (typeof SAVED)[number];
  legacy: (typeof LEGACY)[number];
  flag: (typeof FLAGS)[number];
  noDeep: boolean;
}

const CELLS: Cell[] = [];
for (const command of ["check", "audit"] as const)
  for (const saved of SAVED)
    for (const legacy of LEGACY)
      for (const flag of FLAGS)
        for (const noDeep of [true, false]) CELLS.push({ command, saved, legacy, flag, noDeep });

function cellName(c: Cell): string {
  return [
    c.command,
    `~/.opena2a/config.json ${c.saved.label}`,
    `~/.hackmyagent/config.json ${c.legacy.label}`,
    c.flag ?? "no flag",
    c.noDeep ? "--no-deep" : "deep",
  ].join(" | ");
}

/** Loaded into every process; acts only in the scanner's. */
const PRELOAD = String.raw`
const argv1 = process.argv[1] || "";
if (/[\\/]hackmyagent[\\/]/.test(argv1)) {
  const fs = require("fs");
  const path = require("path");
  const http = require("http");
  const https = require("https");
  const appendFileSync = fs.appendFileSync.bind(fs);
  const log = (entry) => appendFileSync(process.env.MATRIX_LOG, JSON.stringify(entry) + "\n");
  log({ argv: process.argv.slice(2) });

  const watched = process.env.MATRIX_WATCH.split(path.delimiter);
  const toPath = (p) =>
    typeof p === "string" ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : null;
  const watch = (target, names) => {
    for (const name of names) {
      const orig = target[name];
      if (typeof orig !== "function") continue;
      const wrapped = function (...args) {
        const p = toPath(args[0]);
        if (p !== null && watched.includes(path.resolve(p))) log({ opened: path.resolve(p), op: name });
        return orig.apply(this, args);
      };
      Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
      target[name] = wrapped;
    }
  };
  watch(fs, ["existsSync", "statSync", "readFileSync", "openSync", "writeFileSync", "appendFileSync",
    "renameSync", "unlinkSync", "copyFileSync", "exists", "stat", "readFile", "open", "writeFile",
    "appendFile", "rename", "unlink", "copyFile", "createReadStream", "createWriteStream"]);
  watch(fs.promises, ["stat", "readFile", "open", "writeFile", "appendFile", "rename", "unlink", "copyFile"]);
  require("module").syncBuiltinESMExports();

  const capture = new URL(process.env.MATRIX_CAPTURE_URL);
  const stub = new URL(process.env.MATRIX_STUB_URL);
  const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const redirect = (url) => {
    if (url.hostname === "huggingface.co") return new URL("/model-download" + url.pathname, stub);
    if (LOOPBACK.includes(url.hostname) && url.port !== stub.port && url.port !== capture.port) return null;
    const to = new URL("/scanner", capture);
    to.searchParams.set("cell", process.env.MATRIX_CELL);
    to.searchParams.set("to", url.href);
    return to;
  };
  const fetch0 = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const to = redirect(url);
    if (!to) return fetch0(input, init);
    return input instanceof Request ? fetch0(new Request(to, input), init) : fetch0(to, init);
  };
  const request0 = http.request;
  const get0 = http.get;
  for (const [mod, scheme] of [[http, "http:"], [https, "https:"]]) {
    for (const name of ["request", "get"]) {
      const orig = mod[name];
      mod[name] = function (...args) {
        let url;
        let opts = {};
        let rest;
        if (typeof args[0] === "string" || args[0] instanceof URL) {
          url = new URL(String(args[0]));
          rest = args.slice(1);
          if (rest[0] && typeof rest[0] === "object") opts = rest.shift();
        } else {
          opts = args[0] || {};
          const host = opts.hostname || opts.host || "localhost";
          url = new URL(scheme + "//" + host + (opts.port ? ":" + opts.port : "") + (opts.path || "/"));
          rest = args.slice(1);
        }
        const to = redirect(url);
        if (!to) return orig.apply(this, args);
        const options = { method: opts.method || "GET", headers: opts.headers || {} };
        return (name === "get" ? get0 : request0)(to, options, ...rest);
      };
    }
  }
  require("module").syncBuiltinESMExports();
}
`;

let scratch: string;
let fixtureDir: string;
let manifestPath: string;
let preloadPath: string;
let tarball: Buffer;
let stub: Server;
let capture: Server;
let stubUrl: string;
let captureUrl: string;
/** Requests that reached the capture server, by cell. */
const captured = new Map<string, string[]>();

function listen(server: Server): Promise<string> {
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function startStub(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
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
                tarball: `${stubUrl}/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`,
                integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
              },
            },
          },
        });
      }
      if (req.method === "GET" && url.pathname === `/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(tarball);
      }
      // Trust registry: no data for the package, so audit scans it.
      if (req.method === "POST" && url.pathname === "/api/v1/trust/batch") {
        const { packages } = JSON.parse(body) as { packages: { name: string }[] };
        return send(200, {
          results: packages.map((p) => ({ name: p.name, packageId: null })),
          total: packages.length,
        });
      }
      // Classifier model downloads and every other GET: not here.
      if (req.method === "GET") return send(404, { error: "not found" });
      // ai-trust's own scan ping, contribution and usage events.
      return send(200, {});
    });
  });
}

function startCapture(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cell = url.searchParams.get("cell") ?? "unknown";
    captured.set(cell, [
      ...(captured.get(cell) ?? []),
      `${req.method} ${url.searchParams.get("to") ?? url.pathname}`,
    ]);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
}

function readOrNull(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function seedHome(home: string, cell: Cell): void {
  mkdirSync(home, { recursive: true });
  if (cell.saved.content !== null) {
    mkdirSync(join(home, ".opena2a"));
    writeFileSync(join(home, ".opena2a", "config.json"), cell.saved.content);
  }
  if (cell.legacy.content !== null) {
    mkdirSync(join(home, ".hackmyagent"));
    writeFileSync(join(home, ".hackmyagent", "config.json"), cell.legacy.content);
  }
}

/**
 * ~/.opena2a/config.json after ai-trust's own record of an audit's scans,
 * with nothing else running: ai-trust records them when it shares them.
 */
async function afterOwnRecord(cell: Cell, dir: string): Promise<Buffer | null> {
  const home = join(dir, "reference-home");
  seedHome(home, cell);
  const flag = cell.flag === "--contribute" ? "true" : cell.flag === "--no-contribute" ? "false" : "undefined";
  await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(OPT_IN_URL)});` +
        `const d = await import(${JSON.stringify(DECISION_URL)});` +
        `const decision = d.decideContribution({ command: "audit", flag: ${flag}, saved: m.readContributeChoice(), interactive: false, scanned: 1 });` +
        `if (decision.countScans) m.recordScanAndMaybeShowTip();`,
    ],
    { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } },
  );
  return readOrNull(join(home, ".opena2a", "config.json"));
}

function cellEnv(id: string, home: string, log: string): NodeJS.ProcessEnv {
  // No host config, no saved choice other than the cell's, usage telemetry
  // left on as a user who never turned it off would have it.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}`,
    // The scanner refuses an http:// registry URL other than localhost.
    REGISTRY_URL: stubUrl.replace("127.0.0.1", "localhost"),
    OPENA2A_TELEMETRY_URL: `${stubUrl}/telemetry`,
    npm_config_registry: stubUrl,
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_update_notifier: "false",
    MATRIX_CELL: id,
    MATRIX_LOG: log,
    MATRIX_WATCH: [
      join(home, ".opena2a", "config.json"),
      join(home, ".hackmyagent", "config.json"),
    ].join(delimiter),
    MATRIX_CAPTURE_URL: captureUrl,
    MATRIX_STUB_URL: stubUrl,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

interface Outcome {
  scanned: boolean;
  configUnchanged: boolean;
  legacyUnchanged: boolean;
  scannerOpened: string[];
  scannerRequests: string[];
  scannerMode: string[];
}

async function runCell(cell: Cell, id: string): Promise<{ outcome: Outcome; stderr: string }> {
  const dir = join(scratch, "cells", id);
  const home = join(dir, "home");
  const log = join(dir, "scanner.log");
  seedHome(home, cell);
  writeFileSync(log, "");
  const configPath = join(home, ".opena2a", "config.json");
  const legacyPath = join(home, ".hackmyagent", "config.json");
  const legacyBefore = readOrNull(legacyPath);
  const configExpected =
    cell.command === "audit" ? await afterOwnRecord(cell, dir) : readOrNull(configPath);

  const args =
    cell.command === "check"
      ? ["check", "matrix-label", "--scan-path", fixtureDir]
      : ["audit", manifestPath, "--scan-missing", "--registry-url", stubUrl];
  if (cell.flag) args.push(cell.flag);
  if (cell.noDeep) args.push("--no-deep");
  args.push("--json");
  const { stdout, stderr } = await run(args, dir, cellEnv(id, home, log));

  let scanned = false;
  try {
    const out = JSON.parse(stdout);
    scanned =
      cell.command === "check"
        ? out.source === "scan"
        : out.results?.[0]?.scanStatus === "local";
  } catch {
    // Not JSON: the run did not get as far as a result.
  }
  const entries = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv?: string[]; opened?: string; op?: string });
  const secure = entries.filter((e) => e.argv?.includes("secure"));
  const sameBytes = (a: Buffer | null, b: Buffer | null) =>
    a === null || b === null ? a === b : a.equals(b);
  return {
    outcome: {
      scanned,
      configUnchanged: sameBytes(readOrNull(configPath), configExpected),
      legacyUnchanged: sameBytes(readOrNull(legacyPath), legacyBefore),
      scannerOpened: [...new Set(entries.filter((e) => e.opened).map((e) => e.opened as string))],
      scannerRequests: captured.get(id) ?? [],
      scannerMode: secure.flatMap((e) =>
        (e.argv as string[]).filter((a) => a === "--deep" || a === "--static-only"),
      ),
    },
    stderr,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-saved-state-"));
  preloadPath = join(scratch, "scanner-capture.cjs");
  writeFileSync(preloadPath, PRELOAD);

  // A small MCP server package with a skill file, scanned from disk by
  // `check` and downloaded from the stub by `audit`.
  fixtureDir = join(scratch, "fixture");
  mkdirSync(fixtureDir);
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({ name: PACKAGE, version: "1.0.0", main: "index.js" }, null, 2) + "\n",
  );
  writeFileSync(
    join(fixtureDir, "index.js"),
    'const fs = require("fs");\nmodule.exports = (p) => fs.readFileSync(p, "utf8");\n',
  );
  writeFileSync(
    join(fixtureDir, "SKILL.md"),
    "---\nname: read-notes\ndescription: Reads a notes file the user names and summarizes it.\n---\n\n" +
      "# Read notes\n\nRead the file the user names and reply with a short summary.\n",
  );
  writeFileSync(
    join(fixtureDir, "mcp.json"),
    JSON.stringify({ mcpServers: { notes: { command: "node", args: ["index.js"] } } }, null, 2) + "\n",
  );
  execFileSync("npm", ["pack", "--pack-destination", scratch], {
    cwd: fixtureDir,
    env: { PATH: process.env.PATH, HOME: scratch, npm_config_cache: join(scratch, "npm-cache") },
    stdio: "pipe",
  });
  tarball = readFileSync(join(scratch, readdirSync(scratch).find((f) => f.endsWith(".tgz")) ?? ""));

  const project = join(scratch, "project");
  mkdirSync(project);
  manifestPath = join(project, "package.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ name: "matrix-project", dependencies: { [PACKAGE]: "1.0.0" } }, null, 2) + "\n",
  );

  stub = startStub();
  capture = startCapture();
  stubUrl = await listen(stub);
  captureUrl = await listen(capture);
}, 60000);

afterAll(async () => {
  for (const server of [stub, capture]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the bundled scanner during an ai-trust run", () => {
  // The cells run before the tests, as many at a time as the machine has
  // cores, and each test checks one cell's outcome.
  const results = new Map<number, { outcome?: Outcome; stderr: string }>();

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) return;
    let next = 0;
    const worker = async () => {
      while (next < CELLS.length) {
        const index = next++;
        try {
          results.set(index, await runCell(CELLS[index], `cell-${index}`));
        } catch (err) {
          results.set(index, { stderr: String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(2, availableParallelism()) }, worker));
  }, 1_800_000);

  CELLS.forEach((cell, index) => {
    it(cellName(cell), () => {
      expect(existsSync(CLI_PATH), "run npm run build first").toBe(true);
      const { outcome, stderr } = results.get(index) ?? { stderr: "" };
      expect(outcome, stderr.slice(-2000)).toEqual({
        scanned: true,
        configUnchanged: true,
        legacyUnchanged: true,
        scannerOpened: [],
        scannerRequests: [],
        scannerMode: [cell.noDeep ? "--static-only" : "--deep"],
      });
    });
  });
});
