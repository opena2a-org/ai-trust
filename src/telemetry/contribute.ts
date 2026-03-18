/**
 * Community Contribution Module
 *
 * Queue-based contribution of anonymized ai-trust scan summaries to the
 * OpenA2A Registry. Compatible with @opena2a/contribute queue format:
 * events queued by ai-trust are flushed by opena2a-cli, HMA, and vice versa.
 *
 * Queue file: ~/.opena2a/contribute-queue.json
 * Endpoint:   POST registry.opena2a.org/api/v1/contribute
 *
 * PRIVACY: Only summary statistics are sent (totalChecks, passed,
 * severity counts, score, verdict). No file paths, no source code,
 * no raw finding descriptions, no PII.
 */

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname, type as osType, userInfo } from "os";
import { join } from "path";
import { createRequire } from "node:module";
import type { HmaFinding } from "../scanner/hma.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const REGISTRY_URL = "https://registry.opena2a.org";
const FLUSH_THRESHOLD = 10;
const MAX_QUEUE_SIZE = 100;
const TIMEOUT_MS = 10_000;

/**
 * Resolve the path to the OpenA2A home directory.
 * Respects the OPENA2A_HOME env var, defaults to ~/.opena2a.
 */
function getOpena2aHome(): string {
  return (
    process.env.OPENA2A_HOME || join(require("os").homedir(), ".opena2a")
  );
}

function ensureDir(): void {
  const dir = getOpena2aHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Legacy types (kept for backward compatibility with tests)
// ---------------------------------------------------------------------------

/** Anonymized finding sent to the registry. Only check ID, result, and severity. */
export interface ContributionFinding {
  checkId: string;
  result: "pass" | "fail";
  severity: string;
}

/** Legacy payload type. Callers should migrate to queueScanResult(). */
export interface ContributionPayload {
  contributorToken: string;
  packageName: string;
  packageVersion: string;
  ecosystem: "npm" | "pypi" | "github";
  scanTimestamp: string;
  findings: ContributionFinding[];
  aiTrustVersion: string;
  osType: "linux" | "macos" | "windows";
}

/** Result of submitting a contribution. */
export interface ContributionResult {
  success: boolean;
  scanId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// @opena2a/contribute-compatible types
// ---------------------------------------------------------------------------

/** Matches ContributionEvent from @opena2a/contribute/types. */
export interface ContributionEvent {
  type:
    | "scan_result"
    | "detection"
    | "behavior"
    | "interaction"
    | "adoption";
  tool: string;
  toolVersion: string;
  timestamp: string;
  package?: {
    name: string;
    version?: string;
    ecosystem?: string;
  };
  scanSummary?: {
    totalChecks: number;
    passed: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    score: number;
    verdict: string;
    durationMs: number;
  };
}

/** Matches ContributionBatch from @opena2a/contribute/types. */
export interface ContributionBatch {
  contributorToken: string;
  events: ContributionEvent[];
  submittedAt: string;
}

interface QueueFile {
  events: ContributionEvent[];
  lastFlushAttempt?: string;
}

// ---------------------------------------------------------------------------
// Contributor token (stable per-device, SHA256-hashed)
// ---------------------------------------------------------------------------

/**
 * Generate a stable per-device contributor token.
 *
 * SHA256(hostname + username + random salt stored at ~/.opena2a/contributor-salt).
 * The salt is generated once on first call and persisted locally.
 * Shared with hackmyagent so the same device gets the same token.
 */
export function generateContributorToken(): string {
  const home = getOpena2aHome();
  const saltPath = join(home, "contributor-salt");

  let salt: string;
  if (existsSync(saltPath)) {
    salt = readFileSync(saltPath, "utf-8").trim();
  } else {
    salt = randomBytes(32).toString("hex");
    mkdirSync(home, { recursive: true });
    writeFileSync(saltPath, salt, { mode: 0o600 });
  }

  const input = `${hostname()}|${userInfo().username}|${salt}`;
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// OS type resolution
// ---------------------------------------------------------------------------

function resolveOsType(): "linux" | "macos" | "windows" {
  const t = osType();
  if (t === "Darwin") return "macos";
  if (t === "Windows_NT") return "windows";
  return "linux";
}

// ---------------------------------------------------------------------------
// Queue operations (compatible with @opena2a/contribute queue format)
// ---------------------------------------------------------------------------

function queuePath(): string {
  return join(getOpena2aHome(), "contribute-queue.json");
}

function loadQueue(): QueueFile {
  const path = queuePath();
  if (!existsSync(path)) return { events: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { events: [] };
  }
}

function saveQueue(queue: QueueFile): void {
  ensureDir();
  writeFileSync(queuePath(), JSON.stringify(queue), { mode: 0o600 });
}

function queueEvent(event: ContributionEvent): void {
  const queue = loadQueue();
  queue.events.push(event);

  if (queue.events.length > MAX_QUEUE_SIZE) {
    queue.events = queue.events.slice(-MAX_QUEUE_SIZE);
  }

  saveQueue(queue);
}

function shouldFlush(): boolean {
  return loadQueue().events.length >= FLUSH_THRESHOLD;
}

function buildBatch(): ContributionBatch | null {
  const events = loadQueue().events;
  if (events.length === 0) return null;

  return {
    contributorToken: generateContributorToken(),
    events,
    submittedAt: new Date().toISOString(),
  };
}

function clearQueue(): void {
  saveQueue({ events: [] });
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

function computeVerdict(findings: HmaFinding[]): string {
  const critical = findings.filter(
    (f) => !f.passed && f.severity === "critical"
  ).length;
  const high = findings.filter(
    (f) => !f.passed && f.severity === "high"
  ).length;
  if (critical > 0) return "fail";
  if (high > 0) return "warn";
  return "pass";
}

// ---------------------------------------------------------------------------
// Build contribution event from scan findings (summary, not per-finding)
// ---------------------------------------------------------------------------

/**
 * Queue a scan result as a ContributionEvent.
 *
 * Converts the detailed finding list into an anonymized summary:
 * only counts and severity distribution, no file paths or descriptions.
 */
export function queueScanResult(
  packageName: string,
  findings: HmaFinding[],
  durationMs = 0
): void {
  const total = findings.length;
  const passed = findings.filter((f) => f.passed).length;
  const failed = findings.filter((f) => !f.passed);

  const event: ContributionEvent = {
    type: "scan_result",
    tool: "ai-trust",
    toolVersion: VERSION,
    timestamp: new Date().toISOString(),
    package: {
      name: packageName,
      ecosystem: "npm",
    },
    scanSummary: {
      totalChecks: total,
      passed,
      critical: failed.filter((f) => f.severity === "critical").length,
      high: failed.filter((f) => f.severity === "high").length,
      medium: failed.filter((f) => f.severity === "medium").length,
      low: failed.filter((f) => f.severity === "low").length,
      score: total > 0 ? Math.round((passed / total) * 100) : 0,
      verdict: computeVerdict(findings),
      durationMs,
    },
  };

  queueEvent(event);
}

/**
 * Flush queued events to the OpenA2A Registry.
 * Returns true if submission succeeded (or queue was empty).
 */
export async function flushQueue(
  registryUrl?: string,
  verbose?: boolean
): Promise<boolean> {
  const batch = buildBatch();
  if (!batch) return true;

  const url = `${(registryUrl || REGISTRY_URL).replace(/\/+$/, "")}/api/v1/contribute`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `ai-trust/${VERSION}`,
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      clearQueue();
      if (verbose) {
        process.stderr.write(
          `  Shared: anonymized results for ${batch.events.length} scan(s) (community trust)\n`
        );
      }
      return true;
    }

    return false;
  } catch {
    // Offline or unreachable -- events stay in queue for next time
    return false;
  }
}

// ---------------------------------------------------------------------------
// Legacy API (kept for backward compatibility with existing callers/tests)
// ---------------------------------------------------------------------------

/**
 * Build an anonymized contribution payload from scan findings.
 *
 * @deprecated Use queueScanResult() + flushQueue() instead. Kept for
 * backward compatibility. The per-finding payload format is superseded
 * by the summary-based ContributionEvent format.
 *
 * PRIVACY: This function intentionally strips all sensitive fields.
 * The output contains ONLY: checkId, pass/fail result, and severity.
 * No file paths, line numbers, descriptions, fix text, or code content.
 */
export function buildContributionPayload(
  packageName: string,
  findings: HmaFinding[]
): ContributionPayload {
  const contributionFindings: ContributionFinding[] = findings.map((f) => ({
    checkId: f.checkId,
    result: f.passed ? ("pass" as const) : ("fail" as const),
    severity: f.severity,
  }));

  return {
    contributorToken: generateContributorToken(),
    packageName,
    packageVersion: "",
    ecosystem: "npm",
    scanTimestamp: new Date().toISOString(),
    findings: contributionFindings,
    aiTrustVersion: VERSION,
    osType: resolveOsType(),
  };
}

/**
 * Submit a contribution payload to the registry.
 *
 * @deprecated Use queueScanResult() + flushQueue() instead. This legacy
 * function now queues the event internally and flushes, rather than
 * posting per-finding payloads directly.
 */
export async function submitContribution(
  payload: ContributionPayload,
  registryUrl?: string
): Promise<ContributionResult> {
  // Convert legacy payload into a queue event and flush
  const event: ContributionEvent = {
    type: "scan_result",
    tool: "ai-trust",
    toolVersion: payload.aiTrustVersion,
    timestamp: payload.scanTimestamp,
    package: {
      name: payload.packageName,
      ecosystem: payload.ecosystem,
    },
    scanSummary: {
      totalChecks: payload.findings.length,
      passed: payload.findings.filter((f) => f.result === "pass").length,
      critical: payload.findings.filter(
        (f) => f.result === "fail" && f.severity === "critical"
      ).length,
      high: payload.findings.filter(
        (f) => f.result === "fail" && f.severity === "high"
      ).length,
      medium: payload.findings.filter(
        (f) => f.result === "fail" && f.severity === "medium"
      ).length,
      low: payload.findings.filter(
        (f) => f.result === "fail" && f.severity === "low"
      ).length,
      score:
        payload.findings.length > 0
          ? Math.round(
              (payload.findings.filter((f) => f.result === "pass").length /
                payload.findings.length) *
                100
            )
          : 0,
      verdict: "pass",
      durationMs: 0,
    },
  };

  queueEvent(event);
  const ok = await flushQueue(registryUrl);
  return { success: ok };
}
