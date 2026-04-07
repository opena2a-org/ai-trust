/**
 * Scanner module - orchestrates package download, HMA scan, and cleanup.
 */

export { downloadPackage } from "./downloader.js";
export type { DownloadResult } from "./downloader.js";
export { isHmaAvailable, runHmaScan } from "./hma.js";
export type { HmaScanResult, HmaFinding, SemanticFinding, HmaScanOptions } from "./hma.js";

import { downloadPackage } from "./downloader.js";
import { runHmaScan } from "./hma.js";
import type { HmaScanResult, SemanticFinding, HmaScanOptions } from "./hma.js";

export interface ScanResult {
  packageName: string;
  scan: HmaScanResult;
  /** Trust score derived from HMA score (0.0-1.0) */
  trustScore: number;
  /** Trust level derived from scan (0-4) */
  trustLevel: number;
  /** Verdict derived from scan results */
  verdict: "safe" | "warning" | "blocked";
  /** NanoMind semantic analysis results (present when deep scan is enabled) */
  semanticFindings?: SemanticFinding[];
}

/**
 * Download a package, scan it with HMA, and return results.
 * Cleans up the temp directory after scanning.
 */
export async function scanPackage(
  name: string,
  options: HmaScanOptions & { ecosystem?: "npm" | "pypi" } = {}
): Promise<ScanResult> {
  const download = await downloadPackage(name, options.ecosystem ?? "npm");

  try {
    const scan = await runHmaScan(download.dir, options);
    const trustScore = scan.score / scan.maxScore;
    const trustLevel = deriveTrustLevel(scan);
    const verdict = deriveVerdict(scan);

    const result: ScanResult = {
      packageName: name,
      scan,
      trustScore,
      trustLevel,
      verdict,
    };

    if (scan.semanticFindings && scan.semanticFindings.length > 0) {
      result.semanticFindings = scan.semanticFindings;
    }

    return result;
  } finally {
    await download.cleanup();
  }
}

function deriveTrustLevel(scan: HmaScanResult): number {
  const ratio = scan.score / scan.maxScore;
  if (ratio >= 0.9) return 3; // Scanned, high trust
  if (ratio >= 0.7) return 2; // Listed, moderate trust
  if (ratio >= 0.4) return 1; // Warning
  return 0; // Blocked
}

function deriveVerdict(scan: HmaScanResult): "safe" | "warning" | "blocked" {
  const ratio = scan.score / scan.maxScore;
  const hasCritical = scan.findings.some(
    (f) => !f.passed && f.severity === "critical"
  );
  const hasHigh = scan.findings.some(
    (f) => !f.passed && f.severity === "high"
  );

  // Score is the primary verdict driver. Critical/high findings downgrade
  // by one level but never jump straight to blocked. HMA runs generic checks
  // (SQL injection, password hashing, etc.) that may be irrelevant to the
  // package type -- a filesystem MCP server will always "fail" SQL checks.
  if (ratio >= 0.7 && !hasCritical && !hasHigh) return "safe";
  if (ratio >= 0.7) return "warning"; // high score + criticals/high = warning, not blocked
  if (ratio >= 0.4) return "warning";
  return "blocked";
}
