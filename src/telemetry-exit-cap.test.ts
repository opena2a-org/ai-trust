/**
 * An unreachable telemetry endpoint must not hold the process open.
 *
 * The telemetry sender aborts its request after 2 s, but an aborted connect to
 * an address that drops packets keeps the socket, and the process, alive until
 * the socket's own connect timeout (about 10 s). index.ts caps the exit. A
 * refused port (127.0.0.1:1) fails fast and cannot show the stall, so these
 * tests use 192.0.2.1 (TEST-NET-1, RFC 5737), which is not routed.
 *
 * `audit` is a tracked command; on a manifest with no dependencies, or on a
 * missing file, it finishes without the registry, so those cases run offline.
 * Exercises the built `dist/index.js` end-to-end.
 *
 * How the process ended is read from inside it, not from wall time: a probe
 * preloaded with `--require` reports whether the event loop emptied on its own
 * (`beforeExit`, which Node does not emit when `process.exit()` ends the
 * process), how long the process lived after the command finished, and
 * whether a control timer it set when the command finished fired before the
 * process ended.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const DROPPED_ENDPOINT = "http://192.0.2.1/never";
// TELEMETRY_EXIT_CAP_MS in index.ts.
const EXIT_CAP_MS = 2000;
// Longest the process may live after the command finishes, as the control: a
// timer of this length, set in the process when the command finishes, runs
// in the same event loop as the cap, so a loaded machine that delays one
// delays the other. The cap gives about 2 s; a 5 s cap, or no cap (the
// connect timeout, about 10 s), is over.
const MAX_AFTER_COMMAND_MS = 4000;
// How long the slow reader leaves stdout unread: past the cap.
const SLOW_READER_MS = EXIT_CAP_MS + 1500;

// Preloaded into the CLI process. The telemetry debug line is written when
// the command finishes, which starts the clock and the control timer
// (unref'd, so it holds nothing open); `beforeExit` marks an event loop that
// emptied on its own; `exit` reports the elapsed time.
const EXIT_PROBE = `
const fs = require("node:fs");
let commandDoneAt;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (commandDoneAt === undefined && String(chunk).includes("[opena2a:telemetry]")) {
    commandDoneAt = Date.now();
    setTimeout(() => fs.writeSync(2, "[exit-probe] control-fired\\n"), ${MAX_AFTER_COMMAND_MS}).unref();
  }
  return write(chunk, ...rest);
};
process.on("beforeExit", () => {
  fs.writeSync(2, "[exit-probe] loop-empty\\n");
});
process.on("exit", () => {
  const after = commandDoneAt === undefined ? -1 : Date.now() - commandDoneAt;
  fs.writeSync(2, "[exit-probe] afterCommandMs=" + after + "\\n");
});
`;

// A tracked command whose exit is capped at 5 s: it writes its telemetry line
// when it finishes, a send to an endpoint that never answers holds it open (a
// timer stands in for the stuck socket), and a 5 s cap ends it.
const FIVE_SECOND_CAP_COMMAND = `
process.stderr.write('[opena2a:telemetry] {"name":"audit"}\\n');
setTimeout(() => {}, 10000);
setTimeout(() => process.exit(0), 5000).unref();
`;

let workDir: string;
let probePath: string;
let fiveSecondCapPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "ai-trust-exit-cap-"));
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }),
  );
  probePath = join(workDir, "exit-probe.cjs");
  writeFileSync(probePath, EXIT_PROBE);
  fiveSecondCapPath = join(workDir, "five-second-cap.cjs");
  writeFileSync(fiveSecondCapPath, FIVE_SECOND_CAP_COMMAND);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function cliEnv(telemetry: "on" | "off"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    OPENA2A_TELEMETRY: telemetry,
    OPENA2A_TELEMETRY_DEBUG: "print",
    OPENA2A_TELEMETRY_URL: DROPPED_ENDPOINT,
    // A fresh config directory, so a persisted opt-out on the host cannot
    // turn the send off.
    XDG_CONFIG_HOME: join(workDir, "config"),
  };
}

interface AuditRun {
  stderr: string;
  status: number | null;
  /** The event loop emptied on its own; false when `process.exit()` ended the process. */
  loopEmptied: boolean;
  /** Time from the telemetry debug line to the exit; -1 when no line was written. */
  afterCommandMs: number;
  /** The control timer of MAX_AFTER_COMMAND_MS fired before the process ended. */
  controlFired: boolean;
}

/** Run `script` with `args` under the probe. */
function runProbed(script: string, args: string[], telemetry: "on" | "off"): AuditRun {
  const res = spawnSync(process.execPath, ["--require", probePath, script, ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: cliEnv(telemetry),
  });
  const stderr = res.stderr ?? "";
  const after = /\[exit-probe\] afterCommandMs=(-?\d+)/.exec(stderr);
  return {
    stderr,
    status: res.status,
    loopEmptied: stderr.includes("[exit-probe] loop-empty"),
    afterCommandMs: after ? Number(after[1]) : Number.NaN,
    controlFired: stderr.includes("[exit-probe] control-fired"),
  };
}

function runAudit(file: string, telemetry: "on" | "off" = "on"): AuditRun {
  return runProbed(CLI_PATH, ["audit", file], telemetry);
}

/**
 * True when the endpoint gave up before the cap and the process ended on its
 * own: this host answers 192.0.2.1 at once, the stall never happened, and the
 * run says nothing about the cap.
 */
function stallNotExercised(run: AuditRun): boolean {
  return run.loopEmptied && run.afterCommandMs < EXIT_CAP_MS;
}

const NO_STALL_NOTE =
  "this host fails the connect to 192.0.2.1 before the cap, so the stall the cap bounds did not occur";

describe("exit with an unreachable telemetry endpoint", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("a tracked command exits at the cap and keeps exit code 0", (ctx) => {
    if (!existsSync(CLI_PATH)) return;
    const run = runAudit(join(workDir, "package.json"));
    // The event was sent, so the stuck socket was exercised.
    expect(run.stderr).toMatch(/\[opena2a:telemetry\] .*"name":"audit"/);
    expect(run.status).toBe(0);
    if (stallNotExercised(run)) ctx.skip(NO_STALL_NOTE);
    // The cap ended the process, before the control timer fired; the stuck
    // socket did not get to.
    expect(run.loopEmptied).toBe(false);
    expect(run.controlFired).toBe(false);
  }, 40000);

  it("a tracked command that fails exits at the cap and keeps its exit code", (ctx) => {
    if (!existsSync(CLI_PATH)) return;
    const run = runAudit(join(workDir, "missing.json"));
    expect(run.stderr).toMatch(/File not found/);
    expect(run.stderr).toMatch(/\[opena2a:telemetry\] .*"name":"audit"/);
    expect(run.status).toBe(1);
    if (stallNotExercised(run)) ctx.skip(NO_STALL_NOTE);
    expect(run.loopEmptied).toBe(false);
    expect(run.controlFired).toBe(false);
  }, 40000);

  it("holds a command whose exit is capped at 5 s to ending after the control timer fired", () => {
    const run = runProbed(fiveSecondCapPath, [], "on");
    expect(run.loopEmptied).toBe(false);
    expect(run.controlFired).toBe(true);
  }, 40000);
});

describe("exit with telemetry off", () => {
  it("a command exits when its work is done, without waiting for the cap", () => {
    if (!existsSync(CLI_PATH)) return;
    const run = runAudit(join(workDir, "package.json"), "off");
    expect(run.status).toBe(0);
    // No event was sent.
    expect(run.stderr).not.toContain("[opena2a:telemetry]");
    // The loop emptied and the process ended on its own. A cap timer that
    // held the loop would end it through process.exit() instead.
    expect(run.loopEmptied).toBe(true);
  }, 40000);
});

describe("output queued for a slow reader", () => {
  const PACKAGES = Array.from({ length: 100 }, (_, i) => `slow-reader-pkg-${i}`);
  // 100 results of 20 kB each: about 2 MB of JSON, far over a pipe's buffer.
  const PADDING = "x".repeat(20000);
  let server: Server;
  let registryUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { packages } = JSON.parse(body) as { packages: Array<{ name: string }> };
        const results = packages.map((p) => ({
          packageId: "11111111-1111-4111-8111-111111111111",
          name: p.name,
          packageType: "mcp_server",
          trustLevel: 3,
          trustScore: 0.8,
          verdict: "passed",
          scanStatus: "passed",
          communityScans: 0,
          padding: PADDING,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queriedAt: new Date().toISOString(), results, total: results.length }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  it("is written in full when the reader starts after the cap has passed", async () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = await new Promise<{ stdout: string; status: number | null }>(
      (resolveRun, reject) => {
        const child = spawn(
          process.execPath,
          [CLI_PATH, "batch", ...PACKAGES, "--json", "--registry-url", registryUrl],
          { cwd: workDir, env: cliEnv("off"), stdio: ["ignore", "pipe", "ignore"] },
        );
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (out += chunk));
        // Leave the pipe unread until the cap has passed, then read it all.
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), SLOW_READER_MS);
        child.on("error", reject);
        child.on("close", (code) => resolveRun({ stdout: out, status: code }));
      },
    );

    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(PACKAGES.length * PADDING.length);
    const parsed = JSON.parse(stdout) as { results: Array<{ name: string }> };
    expect(parsed.results.map((r) => r.name)).toEqual(PACKAGES);
  }, 40000);
});
