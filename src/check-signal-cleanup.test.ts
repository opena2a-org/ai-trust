/**
 * A `check` that a signal stops during a scan removes the temporary
 * directories the scan made, `ai-trust-scan-*` (the download) and
 * `ai-trust-scanner-*` (the scanner's home), stops the `npm pack` or scanner
 * it started, and ends by the same signal (#177).
 *
 * Exercises the built `dist/index.js` end-to-end, from a copy of the package
 * whose node_modules links every dependency except hackmyagent. In its place
 * is a stand-in scanner that answers --version, and on a scan writes into the
 * home ai-trust gives it, records its pid and waits. The `npm` first on PATH
 * is a stand-in that answers `npm pack` with a fixture tarball, or records its
 * pid and waits. Each run gets its own TMPDIR, so the directories the scan
 * made are the `ai-trust-scan*` entries in it. The registry is a server on
 * 127.0.0.1 that answers every request with 404.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

const FIXTURE_NAME = "interrupt-fixture";
const FIXTURE_TARBALL = `${FIXTURE_NAME}-1.0.0.tgz`;

/**
 * The stand-in scanner. A scan writes a file into the home ai-trust runs it
 * with, as the scanner writes its config there, records its pid in
 * $AI_TRUST_TEST_MARKS/scanner.pid and waits; with
 * AI_TRUST_TEST_IGNORE_SIGNALS set it ignores SIGINT, SIGTERM and SIGHUP.
 * It ends itself after 30 s, so a stand-in no one stopped does not run on.
 */
const STAND_IN_SCANNER = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'if (process.argv.includes("--version")) {',
  '  process.stdout.write("0.0.0\\n");',
  "  process.exit(0);",
  "}",
  'fs.mkdirSync(path.join(process.env.HOME, ".opena2a"), { recursive: true });',
  'fs.writeFileSync(path.join(process.env.HOME, ".opena2a", "config.json"), "{}\\n");',
  "if (process.env.AI_TRUST_TEST_IGNORE_SIGNALS) {",
  '  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});',
  "}",
  'fs.writeFileSync(path.join(process.env.AI_TRUST_TEST_MARKS, "scanner.pid"), String(process.pid));',
  "setTimeout(() => process.exit(3), 30_000);",
  "",
].join("\n");

// Empty until beforeAll has made the directory.
let scratch = "";
let install = "";
let npmBin = "";
let registry: Server | undefined;
let registryUrl = "";
let runs = 0;
/** Pids the stand-ins recorded, stopped after each test if still running. */
const recordedPids: number[] = [];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A copy of the package in a new directory: package.json, dist, and a
 * node_modules that links every dependency except hackmyagent, which is
 * the stand-in scanner.
 */
function installWithStandInScanner(): void {
  install = join(scratch, "install");
  cpSync(join(ROOT, "package.json"), join(install, "package.json"));
  cpSync(join(ROOT, "dist"), join(install, "dist"), { recursive: true });
  const modules = join(install, "node_modules");
  const scanner = join(modules, "hackmyagent");
  mkdirSync(join(scanner, "dist"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "node_modules"))) {
    if (entry === "hackmyagent" || entry.startsWith(".")) continue;
    symlinkSync(join(ROOT, "node_modules", entry), join(modules, entry));
  }
  writeFileSync(
    join(scanner, "package.json"),
    JSON.stringify({ name: "hackmyagent", version: "0.0.0", main: "dist/index.js", bin: { hackmyagent: "dist/cli.js" } }),
  );
  writeFileSync(join(scanner, "dist", "index.js"), "module.exports = {};\n");
  writeFileSync(join(scanner, "dist", "cli.js"), STAND_IN_SCANNER);
}

/**
 * A small package packed the way npm packs it, and an `npm` that answers the
 * downloader's `npm pack ... --pack-destination <dir> ... -- <name>` by
 * copying it into <dir>, or, with AI_TRUST_TEST_PACK_WAITS set, by writing a
 * partial file into <dir>, recording its pid and waiting.
 */
function installNpmStandIn(): void {
  const pkgDir = join(scratch, "fixture", "package");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: FIXTURE_NAME, version: "1.0.0" }));
  execFileSync("tar", ["czf", join(scratch, FIXTURE_TARBALL), "-C", join(scratch, "fixture"), "package"]);

  npmBin = join(scratch, "bin");
  mkdirSync(npmBin);
  writeFileSync(
    join(npmBin, "npm"),
    [
      "#!/bin/sh",
      '[ "$1" = pack ] && [ "$6" = --pack-destination ] || exit 1',
      'if [ -n "$AI_TRUST_TEST_PACK_WAITS" ]; then',
      '  echo partial > "$7/partial.tgz"',
      '  echo $$ > "$AI_TRUST_TEST_MARKS/npm.pid"',
      "  exec sleep 30",
      "fi",
      `cp ${shellQuote(join(scratch, FIXTURE_TARBALL))} "$7/" || exit 1`,
      `echo ${FIXTURE_TARBALL}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(npmBin, "npm"), 0o755);
}

/** A registry that has no package: every request is answered 404. */
function startRegistry(): Promise<Server> {
  const srv = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "package not found" }));
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

interface Interrupted {
  /** The signal that ended ai-trust, or null when it exited with a code. */
  signal: NodeJS.Signals | null;
  code: number | null;
  stderr: string;
  /** The entries of the run's TMPDIR whose names start with `ai-trust-scan`. */
  leftInTmp: string[];
  /** The pid the waiting stand-in recorded. */
  standInPid: number;
}

interface InterruptOptions {
  /** The check arguments after `check`. */
  args: string[];
  /** The stand-in whose pid file says the scan has reached it. */
  waitFor: "scanner" | "npm";
  signal: NodeJS.Signals;
  /** Send the signal to ai-trust's process group, as Ctrl+C in a terminal does. */
  group?: boolean;
  /** Extra variables for the run. */
  env?: Record<string, string>;
  /** The HOME of the run; a new empty one when not given. */
  home?: string;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() > deadline) throw new Error(`${path} was not written within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` is no longer running, false when it still runs after `timeoutMs`. */
async function stops(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * Run `ai-trust check <args>`, wait until the stand-in named by `waitFor` is
 * running, send `signal`, and report how ai-trust ended and what its TMPDIR
 * still holds.
 */
async function interruptCheck(opts: InterruptOptions): Promise<Interrupted> {
  runs += 1;
  const run = join(scratch, `run-${runs}`);
  const tmp = join(run, "tmp");
  const marks = join(run, "marks");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(marks);
  const home = opts.home ?? join(run, "home");
  mkdirSync(home, { recursive: true });

  const child = spawn(process.execPath, [join(install, "dist", "index.js"), "check", ...opts.args], {
    detached: opts.group === true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${npmBin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: tmp,
      NO_COLOR: "1",
      CI: "true",
      OPENA2A_TELEMETRY: "off",
      AI_TRUST_TEST_MARKS: marks,
      ...opts.env,
    },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveEnd) =>
    child.on("exit", (code, signal) => resolveEnd({ code, signal })),
  );

  const pidFile = join(marks, `${opts.waitFor}.pid`);
  await Promise.race([
    waitForFile(pidFile, 30_000),
    ended.then(() => {
      throw new Error(`ai-trust exited before the stand-in ${opts.waitFor} ran:\n${stderr}`);
    }),
  ]);
  const standInPid = Number(readFileSync(pidFile, "utf8").trim());
  recordedPids.push(standInPid);

  if (opts.group === true) {
    process.kill(-(child.pid as number), opts.signal);
  } else {
    child.kill(opts.signal);
  }
  const { code, signal } = await ended;
  // ai-trust may end a moment before the directories it removes are gone
  // from a listing: the listing is read once it has ended.
  const leftInTmp = readdirSync(tmp).filter((entry) => entry.startsWith("ai-trust-scan"));
  return { signal, code, stderr, leftInTmp, standInPid };
}

describe.skipIf(process.platform === "win32")("check stopped by a signal during a scan", () => {
  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) return;
    // The real path, so the paths below match the ones the CLI uses.
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-signal-cleanup-")));
    mkdirSync(join(scratch, "fx"));
    writeFileSync(join(scratch, "fx", "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
    installWithStandInScanner();
    installNpmStandIn();
    registry = await startRegistry();
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const pid of recordedPids.splice(0)) {
      if (isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  afterAll(async () => {
    if (registry) await new Promise<void>((done) => registry?.close(() => done()));
    // Removes the links in node_modules, not what they point to.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("SIGINT to ai-trust alone during a --scan-path scan stops the scanner and removes its home", async () => {
    if (!existsSync(CLI_PATH)) return;
    const result = await interruptCheck({
      args: ["fx", "--scan-path", join(scratch, "fx"), "--no-deep"],
      waitFor: "scanner",
      signal: "SIGINT",
    });

    expect(result.signal).toBe("SIGINT");
    expect(result.leftInTmp).toEqual([]);
    expect(await stops(result.standInPid, 5_000)).toBe(true);
  }, 60_000);

  it("SIGINT to the process group, as Ctrl+C sends it, during a --scan-path scan removes the scanner's home", async () => {
    if (!existsSync(CLI_PATH)) return;
    const result = await interruptCheck({
      args: ["fx", "--scan-path", join(scratch, "fx"), "--no-deep"],
      waitFor: "scanner",
      signal: "SIGINT",
      group: true,
    });

    expect(result.signal).toBe("SIGINT");
    expect(result.leftInTmp).toEqual([]);
    expect(await stops(result.standInPid, 5_000)).toBe(true);
  }, 60_000);

  it("SIGTERM during npm pack stops npm and removes the download directory", async () => {
    if (!existsSync(CLI_PATH)) return;
    const result = await interruptCheck({
      args: [FIXTURE_NAME, "--registry-url", registryUrl, "--no-deep"],
      waitFor: "npm",
      signal: "SIGTERM",
      env: { AI_TRUST_TEST_PACK_WAITS: "1" },
    });

    expect(result.signal).toBe("SIGTERM");
    expect(result.leftInTmp).toEqual([]);
    expect(await stops(result.standInPid, 5_000)).toBe(true);
  }, 60_000);

  it("SIGHUP during a downloaded package's scan removes the download directory and the scanner's home", async () => {
    if (!existsSync(CLI_PATH)) return;
    const result = await interruptCheck({
      args: [FIXTURE_NAME, "--registry-url", registryUrl, "--no-deep"],
      waitFor: "scanner",
      signal: "SIGHUP",
    });

    expect(result.signal).toBe("SIGHUP");
    expect(result.leftInTmp).toEqual([]);
    expect(await stops(result.standInPid, 5_000)).toBe(true);
  }, 60_000);

  it("a scanner that ignores SIGINT is killed, and a deep scan's home is removed without the model directory it links to", async () => {
    if (!existsSync(CLI_PATH)) return;
    // A deep scan links the user's ~/.nanomind into the scanner's home.
    const home = join(scratch, "home-with-models");
    const model = join(home, ".nanomind", "models", "model.bin");
    mkdirSync(join(home, ".nanomind", "models"), { recursive: true });
    writeFileSync(model, "model\n");

    const result = await interruptCheck({
      args: ["fx", "--scan-path", join(scratch, "fx")],
      waitFor: "scanner",
      signal: "SIGINT",
      env: { AI_TRUST_TEST_IGNORE_SIGNALS: "1" },
      home,
    });

    expect(result.signal).toBe("SIGINT");
    expect(result.leftInTmp).toEqual([]);
    expect(await stops(result.standInPid, 5_000)).toBe(true);
    expect(readFileSync(model, "utf8")).toBe("model\n");
  }, 60_000);
});
