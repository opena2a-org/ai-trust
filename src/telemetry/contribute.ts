/**
 * Community Contribution Module
 *
 * Delegates to @opena2a/contribute for queue management and batch submission.
 *
 * Queue file: ~/.opena2a/contribute-queue.json
 * Endpoint:   POST api.oa2a.org/api/v1/contribute
 *
 * PRIVACY: Only summary statistics are sent (totalChecks, passed,
 * severity counts, score, verdict). No file paths, no source code,
 * no raw finding descriptions, no PII.
 */

import {
  contribute,
  getContributorToken,
  queueEvent,
  type ContributionEvent as SharedContributionEvent,
  type ContributionBatch as SharedContributionBatch,
} from "@opena2a/contribute";
import { type as osType } from "os";
import { createRequire } from "node:module";
import type { HmaFinding } from "../scanner/hma.js";

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

/** Result of submitting a contribution. */
export interface ContributionResult {
  success: boolean;
  scanId?: string;
  error?: string;
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
 * stored at ~/.opena2a/contributor-salt).
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
  durationMs = 0
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
    ecosystem: "npm",
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
  findings: HmaFinding[]
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
