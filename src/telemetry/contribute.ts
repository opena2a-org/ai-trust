/**
 * Community Contribution Module
 *
 * Delegates to @opena2a/contribute for queue management and batch submission.
 *
 * Queue file: ~/.opena2a/contribute-queue.json
 * Endpoint:   POST api.oa2a.org/api/v1/contribute
 *
 * PRIVACY: Only summary statistics are sent (package name and version,
 * totalChecks, passed, severity counts, score, verdict) with the
 * pseudonymous contributor token. No file paths, no source code, no raw
 * finding descriptions, no PII.
 */

import {
  contribute,
  getContributorToken,
  type ContributionEvent as SharedContributionEvent,
  type ContributionBatch as SharedContributionBatch,
} from "@opena2a/contribute";
import { firstPartySignerFromEnv } from "@opena2a/registry-client";
import { type as osType } from "os";
import { createRequire } from "node:module";
import type { HmaFinding } from "../scanner/hma.js";
import type { ScanResult } from "../scanner/index.js";
import { createRegistryClient } from "../utils/registry-client.js";
import { buildScanSubmission } from "./publish.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Re-export types (backward compatibility for callers importing from here)
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

/** Re-export ContributionEvent from the shared library. */
export type ContributionEvent = SharedContributionEvent;

/** Re-export ContributionBatch from the shared library. */
export type ContributionBatch = SharedContributionBatch;

// ---------------------------------------------------------------------------
// Contributor token (delegated to @opena2a/contribute)
// ---------------------------------------------------------------------------

/**
 * Generate a stable per-device contributor token.
 * Delegates to @opena2a/contribute. SHA256(hostname + username + random salt
 * stored at ~/.opena2a/contributor-salt). The token is a pseudonymous
 * per-device identifier: it links contributions from the same device to each
 * other, while the hostname and username themselves are never sent.
 */
export { getContributorToken as generateContributorToken };

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
// Verdict computation
// ---------------------------------------------------------------------------

/** "fail" with a failed critical check, "warn" with a failed high check, else "pass". */
function verdictFromCounts(critical: number, high: number): string {
  if (critical > 0) return "fail";
  if (high > 0) return "warn";
  return "pass";
}

function computeVerdict(findings: HmaFinding[]): string {
  const critical = findings.filter(
    (f) => !f.passed && f.severity === "critical"
  ).length;
  const high = findings.filter(
    (f) => !f.passed && f.severity === "high"
  ).length;
  return verdictFromCounts(critical, high);
}

// ---------------------------------------------------------------------------
// Queue a scan result (delegates to @opena2a/contribute)
// ---------------------------------------------------------------------------

/**
 * Queue a scan result as a ContributionEvent.
 *
 * Delegates to @opena2a/contribute for queue management and batch
 * submission. Converts the detailed finding list into an anonymized
 * summary: only counts and severity distribution, no file paths or
 * descriptions.
 */
export function queueScanResult(
  packageName: string,
  findings: HmaFinding[],
  durationMs = 0,
  ecosystem: "npm" | "pypi" | "github" = "npm",
  packageVersion?: string
): void {
  const total = findings.length;
  const passed = findings.filter((f) => f.passed).length;
  const failed = findings.filter((f) => !f.passed);

  const critical = failed.filter((f) => f.severity === "critical").length;
  const high = failed.filter((f) => f.severity === "high").length;
  const medium = failed.filter((f) => f.severity === "medium").length;
  const low = failed.filter((f) => f.severity === "low").length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  const verdict = computeVerdict(findings);

  // Delegate to @opena2a/contribute -- fire-and-forget since the
  // shared library handles queue persistence internally.
  contribute.scanResult({
    tool: "ai-trust",
    toolVersion: VERSION,
    packageName,
    packageVersion,
    ecosystem,
    totalChecks: total,
    passed,
    critical,
    high,
    medium,
    low,
    score,
    verdict,
    durationMs,
  }).catch(() => {
    // Non-fatal: contribution should never crash the scan
  });
}

const SCAN_PING_TIMEOUT_MS = 5000;

// Scan pings sent and not yet answered. The process exit waits for them
// (scanPingsSettled), so the exit cap in index.ts does not end a ping the
// registry is still answering.
const pendingScanPings = new Set<Promise<void>>();

/**
 * Send an anonymous scan ping to the registry.
 *
 * This is separate from the full contribution flow (no findings, no file
 * paths, no contributor identity -- just package name, verdict and
 * score), but it carries the SAME consent requirement. Package name +
 * verdict is scan-result data under the two-bucket telemetry policy:
 * it names what the user scanned, so it is Bucket 2 (opt-in), not
 * Bucket 1 (invocation telemetry, no package names, default-on).
 * Callers MUST gate this on the `send` of decideContribution(), the same
 * decision used for submitContribution -- do not call it unconditionally.
 */
export function sendScanPing(
  packageName: string,
  verdict: string,
  score: number,
  registryUrl = "https://api.oa2a.org",
  ecosystem: "npm" | "pypi" | "github" = "npm"
): void {
  const url = `${registryUrl}/api/v1/contribute`;
  const body = JSON.stringify({
    contributorToken: "anonymous",
    events: [
      {
        type: "scan_ping",
        tool: "ai-trust",
        toolVersion: VERSION,
        timestamp: new Date().toISOString(),
        package: { name: packageName, ecosystem },
        scanSummary: {
          totalChecks: 0,
          passed: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          score,
          verdict,
          durationMs: 0,
        },
      },
    ],
    submittedAt: new Date().toISOString(),
  });

  // Not awaited by the command: never block the user, never crash. The
  // promise is tracked so the process exit can wait for the answer.
  const ping: Promise<void> = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `ai-trust/${VERSION}`,
    },
    body,
    signal: AbortSignal.timeout(SCAN_PING_TIMEOUT_MS),
  }).then(
    async (res) => {
      // The answer's body is not read; release the connection.
      await res.body?.cancel().catch(() => undefined);
    },
    () => {
      // Silently ignore — telemetry must never affect UX
    },
  );
  pendingScanPings.add(ping);
  void ping.then(() => pendingScanPings.delete(ping));
}

/**
 * Resolves once every scan ping sent so far has been answered or has failed.
 * A ping aborts itself after SCAN_PING_TIMEOUT_MS, which bounds the wait.
 * Never rejects.
 */
export async function scanPingsSettled(): Promise<void> {
  await Promise.all(pendingScanPings);
}

/**
 * Flush queued events to the OpenA2A Registry.
 * Returns true if submission succeeded (or queue was empty).
 * Delegates to @opena2a/contribute.
 */
export async function flushQueue(
  registryUrl?: string,
  verbose?: boolean
): Promise<boolean> {
  return contribute.flush(registryUrl, verbose);
}

/**
 * Share scans the user consented to share: queue each scan's summary and
 * flush the queue, then send each scan's per-check results to the registry's
 * publish endpoint. Nothing is printed. Never throws.
 */
export async function submitContribution(
  scans: { name: string; scanResult: ScanResult }[],
  registryUrl: string,
  opts: { ecosystem: "npm" | "pypi"; type?: string }
): Promise<void> {
  try {
    for (const { name, scanResult } of scans) {
      queueScanResult(name, scanResult.scan.findings, 0, opts.ecosystem, scanResult.packageVersion);
    }
    await flushQueue(registryUrl);
  } catch {
    // Non-fatal: contribution should never crash the scan
  }

  // Per-check results via the unified endpoint, for evidence correlation and
  // consensus. ai-trust is NOT first_party_scanner: only a run in our own CI
  // (AI_TRUST_CI_SIGNING_KEY set) self-tags source=ci; a user's run, with no
  // key, is sent as community.
  for (const { name, scanResult } of scans) {
    try {
      const client = createRegistryClient({
        baseUrl: registryUrl,
        userAgent: `ai-trust/${VERSION}`,
      });
      const signer = firstPartySignerFromEnv({
        keyEnv: "AI_TRUST_CI_SIGNING_KEY",
        source: "ci",
      });
      await client.publishScan(
        buildScanSubmission(name, scanResult, {
          toolVersion: VERSION,
          type: opts.type,
          ecosystem: opts.ecosystem,
        }),
        signer,
      );
    } catch {
      // Non-fatal: contribution should never crash the scan
    }
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
 */
export function buildContributionPayload(
  packageName: string,
  findings: HmaFinding[],
  ecosystem: ContributionPayload["ecosystem"] = "npm"
): ContributionPayload {
  const contributionFindings: ContributionFinding[] = findings.map((f) => ({
    checkId: f.checkId,
    result: f.passed ? ("pass" as const) : ("fail" as const),
    severity: f.severity,
  }));

  return {
    contributorToken: getContributorToken(),
    packageName,
    packageVersion: "",
    ecosystem,
    scanTimestamp: new Date().toISOString(),
    findings: contributionFindings,
    aiTrustVersion: VERSION,
    osType: resolveOsType(),
  };
}
