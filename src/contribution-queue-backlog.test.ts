/**
 * A run that shares sends the summaries still queued from earlier runs,
 * with the contributor token, whatever the saved choice is, and a summary
 * of its own scan.
 *
 * The contribute library queues a scan's summary (the check counts) in
 * ~/.opena2a/contribute-queue.json only when contribution is saved as on,
 * and a summary stays queued when its upload failed. Without a saved on,
 * `check --contribute` sends its scan's summary at once, under the word
 * `anonymous` as the scan ping is, and queues nothing. submitContribution
 * flushes the whole queue on every run that shares, so `check --contribute`
 * with contribution saved off also sends a summary an earlier run left
 * queued, and the batch that carries it carries the contributor token. The
 * README and docs/use-cases/contribute-scans.md say so; this file holds them
 * to it.
 *
 * Each case runs the built `dist/index.js` with its own HOME against one
 * local server that plays both registries, as the decision table does: the
 * npm registry `npm pack` downloads the package from, and the trust
 * registry, which has no data for the package and captures each batch
 * posted to /api/v1/contribute.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const PACKAGE = "queue-backlog-fixture-pkg";
const EARLIER_PACKAGE = "earlier-run-fixture-pkg";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const HEX_64 = /^[0-9a-f]{64}$/;

/** Contribution saved as off, as `ai-trust config contribute off` saves it. */
const SAVED_OFF = `{"contribute":{"enabled":false,"decidedAt":"${SEEDED_AT}"}}\n`;

/** Contribution saved as on, as `ai-trust config contribute on` saves it. */
const SAVED_ON = `{"contribute":{"enabled":true,"decidedAt":"${SEEDED_AT}"}}\n`;

/** A summary an earlier run queued while contribution was saved as on. */
const QUEUED_SUMMARY = {
  type: "scan_result",
  tool: "ai-trust",
  toolVersion: "0.0.0",
  timestamp: SEEDED_AT,
  package: { name: EARLIER_PACKAGE, version: "1.0.0", ecosystem: "npm" },
  scanSummary: {
    totalChecks: 3,
    passed: 2,
    critical: 0,
    high: 1,
    medium: 0,
    low: 0,
    score: 67,
    verdict: "warn",
    durationMs: 0,
  },
};

interface ContributeEvent {
  type?: string;
  package?: { name?: string };
  scanSummary?: {
    totalChecks: number;
    passed: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    score: number;
  };
}

interface Batch {
  contributorToken?: string;
  events?: ContributeEvent[];
}

interface Observed {
  /** Each batch posted to /api/v1/contribute, in order. */
  batches: Batch[];
  /** The per-check results reached /api/v1/trust/publish. */
  published: boolean;
  /** The queue file after the run, or null when there is none. */
  queue: { events: unknown[] } | null;
  /** The scan's `--json` result. */
  result: { score?: number };
}

let scratch: string;
let server: Server;
let baseUrl: string;
let tarballName: string;
let tarball: Buffer;
/** Batches posted to the trust registry, by case prefix. */
const captured = new Map<string, Batch[]>();
const published = new Set<string>();

function startServer(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
    const match = /^\/(q\d+)(\/.*)$/.exec(url.pathname);
    const key = match ? match[1] : "unprefixed";
    const path = match ? match[2] : url.pathname;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "GET" && path === "/api/v1/trust/query") {
        return send(404, { error: "package not found" });
      }
      if (req.method === "POST" && path === "/api/v1/contribute") {
        let batch: Batch;
        try {
          batch = JSON.parse(body) as Batch;
        } catch {
          batch = { events: [{ type: "(not JSON)" }] };
        }
        captured.set(key, [...(captured.get(key) ?? []), batch]);
        return send(200, {});
      }
      if (req.method === "POST" && path === "/api/v1/trust/publish") {
        published.add(key);
        return send(200, { accepted: true });
      }
      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

function cellEnv(home: string): NodeJS.ProcessEnv {
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
  return env;
}

/** `check <package> --no-deep --json --contribute` with the given saved choice and queue. */
function runCheck(prefix: string, queued: unknown[], saved = SAVED_OFF): Promise<Observed> {
  const home = join(scratch, "cases", prefix);
  mkdirSync(join(home, ".opena2a"), { recursive: true });
  writeFileSync(join(home, ".opena2a", "config.json"), saved);
  const queuePath = join(home, ".opena2a", "contribute-queue.json");
  if (queued.length > 0) writeFileSync(queuePath, JSON.stringify({ events: queued }));

  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "check", PACKAGE, "--no-deep", "--contribute", "--json", "--registry-url", `${baseUrl}/${prefix}`],
      { cwd: home, env: cellEnv(home), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => {
      if (!stdout.trim().startsWith("{")) {
        reject(new Error(`${prefix}: no JSON on stdout\n${stdout}\n${stderr}`));
        return;
      }
      resolveRun({
        batches: captured.get(prefix) ?? [],
        published: published.has(prefix),
        queue: existsSync(queuePath) ? (JSON.parse(readFileSync(queuePath, "utf-8")) as { events: unknown[] }) : null,
        result: JSON.parse(stdout) as { score?: number },
      });
    });
    child.stdin.end();
  });
}

function eventsOfType(batches: Batch[], type: string): ContributeEvent[] {
  return batches.flatMap((b) => (b.events ?? []).filter((e) => e.type === type));
}

/** The contributor token of the batch that carries the summary of `name`. */
function tokenOfSummary(batches: Batch[], name: string): string | undefined {
  return batches.find((b) =>
    (b.events ?? []).some((e) => e.type === "scan_result" && e.package?.name === name),
  )?.contributorToken;
}

beforeAll(async () => {
  if (!existsSync(CLI_PATH)) return;
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-queue-backlog-"));
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const source = join(scratch, "source");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: PACKAGE, version: "1.0.0" }));
  writeFileSync(join(source, "index.js"), "module.exports = 1;\n");
  execFileSync("npm", ["pack", "--pack-destination", scratch], {
    cwd: source,
    env: cellEnv(join(scratch, "pack-home")),
    stdio: "pipe",
  });
  tarballName = readdirSync(scratch).find((f) => f.endsWith(".tgz")) ?? "";
  tarball = readFileSync(join(scratch, tarballName));
}, 120000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("check --contribute with contribution saved off", () => {
  it("has a built CLI to run", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("sends a summary an earlier run left queued with the contributor token, and this scan's summary as anonymous", async () => {
    if (!existsSync(CLI_PATH)) return;
    const run = await runCheck("q1", [QUEUED_SUMMARY]);

    const summaries = eventsOfType(run.batches, "scan_result");
    expect(summaries.map((e) => e.package?.name).sort()).toEqual([EARLIER_PACKAGE, PACKAGE].sort());
    expect(tokenOfSummary(run.batches, EARLIER_PACKAGE)).toMatch(HEX_64);
    expect(tokenOfSummary(run.batches, PACKAGE)).toBe("anonymous");

    // The scan itself still sends its ping, as `anonymous`, and its per-check results.
    expect(eventsOfType(run.batches, "scan_ping").map((e) => e.package?.name)).toEqual([PACKAGE]);
    expect(run.batches.filter((b) => (b.events ?? []).some((e) => e.type === "scan_ping")).map((b) => b.contributorToken)).toEqual(["anonymous"]);
    expect(run.published).toBe(true);

    // The registry accepted the batch, so the queue is empty afterwards.
    expect(run.queue?.events ?? []).toEqual([]);
  }, 120000);

  // #123: the summary of a scan shared with --contribute alone was never sent.
  it("sends this scan's summary as anonymous, no contributor token, and queues nothing when nothing is queued", async () => {
    if (!existsSync(CLI_PATH)) return;
    const run = await runCheck("q2", []);

    expect(eventsOfType(run.batches, "scan_result").map((e) => e.package?.name)).toEqual([PACKAGE]);
    expect(run.batches.map((b) => b.contributorToken)).toEqual(["anonymous", "anonymous"]);
    expect(eventsOfType(run.batches, "scan_ping").map((e) => e.package?.name)).toEqual([PACKAGE]);
    expect(run.published).toBe(true);
    expect(run.queue).toBeNull();
  }, 120000);
});

describe("check --contribute with contribution saved on", () => {
  // #123: the summary's counts and score were computed from the scanner's
  // findings, which list only the checks that failed: 0 checks and a score
  // of 0 for a scan the terminal and the published scan score 100.
  it("sends this scan's summary with the contributor token, the scan's score and its passed checks", async () => {
    if (!existsSync(CLI_PATH)) return;
    const run = await runCheck("q3", [], SAVED_ON);

    const summaries = eventsOfType(run.batches, "scan_result");
    expect(summaries.map((e) => e.package?.name)).toEqual([PACKAGE]);
    expect(tokenOfSummary(run.batches, PACKAGE)).toMatch(HEX_64);

    const summary = summaries[0].scanSummary;
    expect(typeof run.result.score).toBe("number");
    expect(summary?.score).toBe(run.result.score);
    expect(summary?.passed).toBeGreaterThan(0);
    expect(summary?.totalChecks).toBe(
      (summary?.passed ?? 0) +
        (summary?.critical ?? 0) +
        (summary?.high ?? 0) +
        (summary?.medium ?? 0) +
        (summary?.low ?? 0),
    );
    expect(run.published).toBe(true);
    expect(run.queue?.events ?? []).toEqual([]);
  }, 120000);
});
