/**
 * Builds the scan submission that `check` and `audit` publish to the
 * registry when the user has opted in to contribution.
 *
 * PRIVACY: each finding is reduced to its check ID, severity, pass/fail,
 * category and attack class. Finding names and messages are never sent:
 * a message can quote the scanned files (for example a scope finding that
 * echoes the contents of an `mcp.json`). The `name` and `message` fields
 * stay on the wire because the registry's finding schema requires them;
 * `name` carries the check ID and `message` is empty.
 */

import type { ScanFinding, ScanSubmission } from "@opena2a/registry-client";
import type { HmaFinding } from "../scanner/hma.js";
import type { ScanResult } from "../scanner/index.js";

/** Reduce scanner findings to the fields the registry needs to correlate them. */
export function toPublishedFindings(findings: HmaFinding[]): ScanFinding[] {
  return findings.map((f) => ({
    checkId: f.checkId,
    name: f.checkId,
    severity: f.severity,
    passed: f.passed,
    message: "",
    category: f.category,
    attackClass: f.attackClass,
  }));
}

function toPublishedVerdict(verdict: ScanResult["verdict"]): string {
  if (verdict === "blocked") return "fail";
  if (verdict === "warning") return "warn";
  return "pass";
}

/**
 * `ecosystem` is the registry the scanned package was downloaded from. The
 * registry records a submission without one as npm, so a PyPI scan that
 * left it out was stored as an npm package's scan.
 */
export function buildScanSubmission(
  name: string,
  scanResult: ScanResult,
  opts: { toolVersion: string; type?: string; ecosystem: "npm" | "pypi" },
): ScanSubmission {
  return {
    name,
    version: scanResult.packageVersion,
    ecosystem: opts.ecosystem,
    type: opts.type,
    score: scanResult.scan.score,
    maxScore: scanResult.scan.maxScore,
    tool: "ai-trust",
    toolVersion: opts.toolVersion,
    verdict: toPublishedVerdict(scanResult.verdict),
    findings: toPublishedFindings(scanResult.scan.findings),
    projectType: scanResult.scan.projectType,
    scanTimestamp: new Date().toISOString(),
  };
}
