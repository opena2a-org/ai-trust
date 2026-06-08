/**
 * Machine-readable JSON shape for `ai-trust check --json`.
 *
 * opena2a-cli exposes `ai-trust check <pkg>` as `opena2a registry <pkg>` and
 * forwards `--json` for programmatic consumption. The two in-scope check paths
 * — a registry lookup (`TrustAnswer`) and a local scan (`ScanResult`) — carry
 * different native shapes, so this module maps BOTH onto one stable,
 * camelCase, documented object. Every field traces to a real value the check
 * pipeline already computed; a value that a given path does not produce is
 * OMITTED, never fabricated.
 */

import type { TrustAnswer } from "@opena2a/registry-client";
import type { ScanResult } from "../scanner/index.js";

/** A single security finding surfaced in the JSON output. */
export interface CheckJsonFinding {
  checkId: string;
  name: string;
  severity: string;
  passed: boolean;
  /** Present only when the underlying finding carried a message. */
  message?: string;
  /** Present only when the underlying finding carried a category. */
  category?: string;
  /** Present only when the underlying finding carried an attack class. */
  attackClass?: string;
}

/** Stable, camelCase trust result for `ai-trust check --json`. */
export interface CheckJsonResult {
  /** Package name as resolved by the check pipeline. */
  name: string;
  /** Where the result came from: registry lookup vs. local HMA scan. */
  source: "registry" | "scan";
  /** True when the registry had data / the scan produced a result. */
  found: boolean;
  /** Registry/HMA package classification, when known. */
  packageType?: string;
  /** Trust verdict (e.g. passed, warning, blocked, safe). */
  verdict?: string;
  /** Derived trust level (0–4), when available. */
  trustLevel?: number;
  /** Normalized trust score in 0.0–1.0, when available. */
  trustScore?: number;
  /** Raw HMA points scored (scan path only). */
  score?: number;
  /** Raw HMA maximum points (scan path only). */
  maxScore?: number;
  /** Failed security findings (scan path only; omitted when none). */
  findings?: CheckJsonFinding[];
}

function mapFinding(f: {
  checkId: string;
  name: string;
  severity: string;
  passed: boolean;
  message?: string;
  category?: string;
  attackClass?: string;
}): CheckJsonFinding {
  const out: CheckJsonFinding = {
    checkId: f.checkId,
    name: f.name,
    severity: f.severity,
    passed: f.passed,
  };
  if (f.message !== undefined && f.message !== "") out.message = f.message;
  if (f.category !== undefined) out.category = f.category;
  if (f.attackClass !== undefined) out.attackClass = f.attackClass;
  return out;
}

/** Build the JSON result from a registry `TrustAnswer`. */
export function buildCheckJsonFromAnswer(answer: TrustAnswer): CheckJsonResult {
  const out: CheckJsonResult = {
    name: answer.name,
    source: "registry",
    found: answer.found,
  };
  if (answer.packageType !== undefined) out.packageType = answer.packageType;
  if (answer.verdict !== undefined) out.verdict = answer.verdict;
  if (answer.trustLevel !== undefined) out.trustLevel = answer.trustLevel;
  if (answer.trustScore !== undefined) out.trustScore = answer.trustScore;
  // The registry lookup does not return raw HMA score/maxScore or per-finding
  // detail, so those fields are intentionally omitted on this path.
  return out;
}

/** Build the JSON result from a local `ScanResult`. */
export function buildCheckJsonFromScan(scan: ScanResult): CheckJsonResult {
  const out: CheckJsonResult = {
    name: scan.packageName,
    source: "scan",
    // A scan always produced a result for this package.
    found: true,
    verdict: scan.verdict,
    trustLevel: scan.trustLevel,
    trustScore: scan.trustScore,
    score: scan.scan.score,
    maxScore: scan.scan.maxScore,
  };
  if (scan.scan.projectType !== undefined) out.packageType = scan.scan.projectType;
  const failed = (scan.scan.findings ?? []).filter((f) => !f.passed);
  if (failed.length > 0) out.findings = failed.map(mapFinding);
  return out;
}

/** Convenience union builder. */
export function buildCheckJson(
  input: { kind: "registry"; answer: TrustAnswer } | { kind: "scan"; scan: ScanResult },
): CheckJsonResult {
  return input.kind === "registry"
    ? buildCheckJsonFromAnswer(input.answer)
    : buildCheckJsonFromScan(input.scan);
}
