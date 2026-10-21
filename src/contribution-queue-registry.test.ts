/**
 * Summaries queued with contribution saved as on go out once, in one batch,
 * to the registry the run was given (#271).
 *
 * submitContribution queued each summary through the contribute library's
 * contribute.scanResult, which sends the queue on its own whenever it holds
 * 10 or more events, to https://api.oa2a.org when it is passed no
 * registryUrl. The flush that followed sent the same summaries to the
 * registry the run was given, so with ten summaries queued each went to
 * both registries.
 *
 * Each case runs the built `dist/telemetry/contribute.js` in a child process
 * with its own HOME, contribution saved as on there and the real contribute
 * library, and puts a recorder in place of fetch, which notes each request
 * and answers it with 200 without sending it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_PATH = resolve(__dirname, "../dist/telemetry/contribute.js");
/** The registry the run is given. The recorder answers in its place; nothing connects to it. */
const REGISTRY_URL = "http://127.0.0.1:9";
const HEX_64 = /^[0-9a-f]{64}$/;
const SAVED_AT = "2026-01-01T00:00:00.000Z";

/** Contribution saved as on, as `ai-trust config contribute on` saves it. */
const SAVED_ON = `{"contribute":{"enabled":true,"decidedAt":"${SAVED_AT}"}}\n`;

/**
 * Puts a recorder in place of fetch, shares the scans in SHARED_SCANS with
 * submitContribution, and prints the requests it recorded once the process
 * has nothing left to run.
 */
const RUNNER = `
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requests.push({ method: init.method ?? "GET", url, body: typeof init.body === "string" ? init.body : null });
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};
process.once("beforeExit", () => process.stdout.write(JSON.stringify(requests)));
const { submitContribution } = await import(process.env.CONTRIBUTE_MODULE_URL);
await submitContribution(JSON.parse(process.env.SHARED_SCANS), process.env.REGISTRY_URL, { ecosystem: "npm" });
`;

interface Recorded {
  method: string;
  url: string;
  body: string | null;
}

interface Batch {
  contributorToken?: string;
  events?: Array<{ type?: string; package?: { name?: string } }>;
}

interface Run {
  /** Every request the run made, in order. */
  requests: Recorded[];
  /** Each batch posted to /api/v1/contribute, with the URL it went to. */
  batches: Array<{ url: string; batch: Batch }>;
  /** The queue file after the run, or null when there is none. */
  queue: { events: unknown[] } | null;
}

let scratch: string;

beforeAll(() => {
  if (!existsSync(MODULE_PATH)) return;
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-queue-registry-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A shared scan of `name` that passed its five checks. */
function scanOf(name: string) {
  return {
    name,
    scanResult: {
      packageName: name,
      packageVersion: "1.0.0",
      scan: {
        score: 100,
        maxScore: 100,
        findings: [],
        checksPassed: 5,
        projectType: "library",
        timestamp: SAVED_AT,
      },
      trustScore: 1,
      trustLevel: 3,
      verdict: "passed",
    },
  };
}

/** A summary an earlier run left queued. */
function earlierSummary(name: string) {
  return {
    type: "scan_result",
    tool: "ai-trust",
    toolVersion: "0.0.0",
    timestamp: SAVED_AT,
    package: { name, version: "1.0.0", ecosystem: "npm" },
    scanSummary: {
      totalChecks: 5,
      passed: 5,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      score: 100,
      verdict: "pass",
      durationMs: 0,
    },
  };
}

/**
 * submitContribution over a scan of each of `names`, in a home of its own
 * with contribution saved as on and `queued` left in the queue.
 */
function share(home: string, names: string[], queued: unknown[] = []): Run {
  const dir = join(scratch, home);
  mkdirSync(join(dir, ".opena2a"), { recursive: true });
  writeFileSync(join(dir, ".opena2a", "config.json"), SAVED_ON);
  const queuePath = join(dir, ".opena2a", "contribute-queue.json");
  if (queued.length > 0) writeFileSync(queuePath, JSON.stringify({ events: queued }));

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    CONTRIBUTE_MODULE_URL: pathToFileURL(MODULE_PATH).href,
    REGISTRY_URL,
    SHARED_SCANS: JSON.stringify(names.map(scanOf)),
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", RUNNER], {
    cwd: dir,
    env,
    encoding: "utf-8",
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const requests = JSON.parse(child.stdout) as Recorded[];
  return {
    requests,
    batches: requests
      .filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/v1/contribute")
      .map((r) => ({ url: r.url, batch: JSON.parse(r.body ?? "{}") as Batch })),
    queue: existsSync(queuePath) ? (JSON.parse(readFileSync(queuePath, "utf-8")) as { events: unknown[] }) : null,
  };
}

/** The package name of each event of a batch, in order. */
function namesIn(batch: Batch): Array<string | undefined> {
  return (batch.events ?? []).map((e) => e.package?.name);
}

/** The requests of a run that went anywhere but the registry it was given. */
function elsewhere(run: Run): Recorded[] {
  return run.requests.filter((r) => !r.url.startsWith(`${REGISTRY_URL}/`));
}

describe("summaries queued with contribution saved as on (#271)", () => {
  it("has a built module to run", () => {
    expect(existsSync(MODULE_PATH)).toBe(true);
  });

  it("go once, in one batch to the registry the run was given and none to api.oa2a.org, when ten are queued", () => {
    if (!existsSync(MODULE_PATH)) return;
    const names = Array.from({ length: 10 }, (_, i) => `queue-registry-pkg-${i}`);

    const run = share("ten", names);

    expect(run.batches.map((b) => b.url)).toEqual([`${REGISTRY_URL}/api/v1/contribute`]);
    expect(namesIn(run.batches[0].batch)).toEqual(names);
    expect(run.batches[0].batch.contributorToken).toMatch(HEX_64);
    // The per-check results go to the same registry; no request goes anywhere else.
    expect(elsewhere(run)).toEqual([]);
    // The registry accepted the batch, so the queue is empty afterwards.
    expect(run.queue).toEqual({ events: [] });
  }, 60_000);

  it("go once each, in one batch, when twenty-five are queued", () => {
    if (!existsSync(MODULE_PATH)) return;
    const names = Array.from({ length: 25 }, (_, i) => `queue-registry-pkg-${i}`);

    const run = share("twenty-five", names);

    expect(run.batches.map((b) => b.url)).toEqual([`${REGISTRY_URL}/api/v1/contribute`]);
    expect(namesIn(run.batches[0].batch)).toEqual(names);
    expect(elsewhere(run)).toEqual([]);
    expect(run.queue).toEqual({ events: [] });
  }, 60_000);

  it("go with the nine an earlier run left queued, in the same batch to the same registry", () => {
    if (!existsSync(MODULE_PATH)) return;
    const earlier = Array.from({ length: 9 }, (_, i) => `earlier-run-pkg-${i}`);

    const run = share("backlog", ["queue-registry-pkg"], earlier.map(earlierSummary));

    expect(run.batches.map((b) => b.url)).toEqual([`${REGISTRY_URL}/api/v1/contribute`]);
    expect(namesIn(run.batches[0].batch)).toEqual([...earlier, "queue-registry-pkg"]);
    expect(elsewhere(run)).toEqual([]);
    expect(run.queue).toEqual({ events: [] });
  }, 60_000);
});
