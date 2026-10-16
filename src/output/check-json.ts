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
import {
  readSecurityProfile,
  type RegistrySecurityProfile,
} from "./security-profile.js";

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
  /**
   * Ecosystem the package was checked under: "pypi" for a `pip:<name>`
   * target, "npm" otherwise. It comes from the target, not from the
   * registry's answer (`TrustAnswer` has no ecosystem field). Omitted for
   * `--scan-path`, which scans a directory rather than a package.
   */
  ecosystem?: "npm" | "pypi";
  /** Where the result came from: registry lookup vs. local HMA scan. */
  source: "registry" | "scan";
  /** True when the registry had data / the scan produced a result. */
  found: boolean;
  /** Registry/HMA package classification, when known. */
  packageType?: string;
  /**
   * Trust verdict. The registry path returns the registry's vocabulary
   * (passed, listed, warning, blocked); the scan path returns safe,
   * warning or blocked.
   */
  verdict?: string;
  /** Derived trust level (0–4), when available. */
  trustLevel?: number;
  /** Normalized trust score in 0.0–1.0, when available. */
  trustScore?: number;
  /** Registry scan status, e.g. passed or warnings (registry path only). */
  scanStatus?: string;
  /** ISO timestamp of the registry's last scan (registry path only). */
  lastScannedAt?: string;
  /**
   * Critical and high finding counts and known CVE identifiers the registry
   * records for the package (registry path only; omitted when the registry
   * returned no profile). A count the registry did not report is omitted
   * from the object.
   */
  securityProfile?: RegistrySecurityProfile;
  /** Raw HMA points scored (scan path only). */
  score?: number;
  /** Raw HMA maximum points (scan path only). */
  maxScore?: number;
  /** Failed security findings (scan path only; omitted when none). */
  findings?: CheckJsonFinding[];
  /**
   * Number of files the scanner read (scan path only; omitted when the
   * scanner did not report it).
   */
  filesExamined?: number;
  /**
   * `false` when the scan read 0 files. The result then carries no score,
   * verdict, trust level, package type or findings, because nothing was
   * measured; `notScoredReason` says why.
   */
  scored?: false;
  notScoredReason?: string;
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
export function buildCheckJsonFromAnswer(
  answer: TrustAnswer,
  ecosystem?: "npm" | "pypi",
): CheckJsonResult {
  const out: CheckJsonResult = {
    name: answer.name,
    ...(ecosystem !== undefined ? { ecosystem } : {}),
    source: "registry",
    found: answer.found,
  };
  if (answer.packageType !== undefined) out.packageType = answer.packageType;
  if (answer.verdict !== undefined) out.verdict = answer.verdict;
  if (answer.trustLevel !== undefined) out.trustLevel = answer.trustLevel;
  if (answer.trustScore !== undefined) out.trustScore = answer.trustScore;
  if (answer.scanStatus) out.scanStatus = answer.scanStatus;
  if (answer.lastScannedAt) out.lastScannedAt = answer.lastScannedAt;
  const profile = readSecurityProfile(answer);
  if (profile) out.securityProfile = profile;
  // The registry lookup does not return raw HMA score/maxScore or per-finding
  // detail, so those fields are intentionally omitted on this path.
  return out;
}

/** Build the JSON result from a local `ScanResult`. */
export function buildCheckJsonFromScan(
  scan: ScanResult,
  ecosystem?: "npm" | "pypi",
): CheckJsonResult {
  // A scan that read 0 files measured nothing: the not-scored shape, as the
  // out-of-scope answer uses, with the count that makes it so.
  if (scan.scan.filesExamined === 0) {
    return {
      name: scan.packageName,
      ...(ecosystem !== undefined ? { ecosystem } : {}),
      source: "scan",
      found: true,
      scored: false,
      notScoredReason: "nothing to scan: the scanner read 0 files",
      filesExamined: 0,
    };
  }
  const out: CheckJsonResult = {
    name: scan.packageName,
    ...(ecosystem !== undefined ? { ecosystem } : {}),
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
  if (scan.scan.filesExamined !== undefined) out.filesExamined = scan.scan.filesExamined;
  return out;
}

/** Convenience union builder. */
export function buildCheckJson(
  input:
    | { kind: "registry"; answer: TrustAnswer; ecosystem?: "npm" | "pypi" }
    | { kind: "scan"; scan: ScanResult; ecosystem?: "npm" | "pypi" },
): CheckJsonResult {
  return input.kind === "registry"
    ? buildCheckJsonFromAnswer(input.answer, input.ecosystem)
    : buildCheckJsonFromScan(input.scan, input.ecosystem);
}
