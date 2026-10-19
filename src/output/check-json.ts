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
import { nothingToScan } from "../scanner/hma.js";
import {
  readSecurityProfile,
  type RegistrySecurityProfile,
} from "./security-profile.js";
import { verifyCommand } from "./finding-location.js";

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
  /** Path of the file the finding is in, as the scanner reported it. */
  file?: string;
  /** 1-based line in `file`; present only when the scanner reported one. */
  line?: number;
  /** The scanner's fix for the finding, when it supplied one. */
  fix?: string;
  /**
   * The command that prints `line` of `file` in the scanned directory, as the
   * text output's Verify line prints it (`check --scan-path` only). Omitted
   * when the finding has no line or its file is not in the directory.
   */
  verify?: string;
}

/**
 * The directory `check --scan-path` scanned, and the `file` values of
 * findings that name nothing in it.
 */
export interface ScannedDirectory {
  scanPath: string;
  absentFiles: ReadonlySet<string>;
}

/** The registry's answer beside a local scan, each field as the registry sent it. */
export interface CheckJsonRegistryAnswer {
  verdict?: string;
  trustLevel?: number;
  /** Normalized trust score in 0.0–1.0. */
  trustScore?: number;
  scanStatus?: string;
  /** ISO timestamp of the registry's last scan. */
  lastScannedAt?: string;
  /**
   * "package" when the target gave a version: the registry's answer is the
   * package's, not the scanned version's.
   */
  answerScope?: "package";
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
  /**
   * Version of the package that was downloaded and scanned, read from its
   * own manifest (scan path only). A `<name>@<tag>` or `<name>@<range>`
   * target keeps the tag or range in `name`; this is the version it
   * resolved to. Omitted when the manifest carries no usable version.
   */
  version?: string;
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
  /**
   * Number of community scans the registry records (registry path only;
   * omitted when the answer carries no count). Text output prints it as the
   * Scans line when it is above 0.
   */
  communityScans?: number;
  /**
   * The version or tag a `<name>@<version>` target gave (registry path only).
   * The registry is asked about the package by name, so `answerScope` is
   * then "package": the answer is the package's, not this version's.
   */
  requestedVersion?: string;
  answerScope?: "package";
  /**
   * The registry's answer for the package, when the scan path looked it up
   * and the registry has it. Text output prints its score beside the scan's
   * when the two differ by more than 20 points.
   */
  registry?: CheckJsonRegistryAnswer;
  /**
   * Why the scan path's registry lookup failed, when it did (scan path only).
   * The scan went ahead without the registry's answer.
   */
  registryError?: string;
  /**
   * Static and semantic check counts, as the text Checks line prints them
   * (scan path only). `semanticLayer` says whether the semantic layer ran
   * ("ran"), was turned off with --no-deep ("not-run"), or ran on a scanner
   * that does not report its count ("not-reported"); `semantic` is present
   * only when it ran and reported a count.
   */
  checks?: {
    static: number;
    semantic?: number;
    semanticLayer: "ran" | "not-run" | "not-reported";
  };
  /**
   * Check ids of failed findings left out of a downloaded package's score
   * (scan path only; omitted when none were). They describe a local setup
   * rather than the package itself; `--scan-path` counts them.
   */
  notCounted?: string[];
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
  file?: string;
  line?: number;
  fix?: string;
}, scanned: ScannedDirectory | undefined): CheckJsonFinding {
  const out: CheckJsonFinding = {
    checkId: f.checkId,
    name: f.name,
    severity: f.severity,
    passed: f.passed,
  };
  if (f.message !== undefined && f.message !== "") out.message = f.message;
  if (f.category !== undefined) out.category = f.category;
  if (f.attackClass !== undefined) out.attackClass = f.attackClass;
  if (typeof f.file === "string" && f.file !== "") out.file = f.file;
  // A line that is not a number (absent, or null in the scanner's JSON) is
  // no line, so the field is omitted rather than written as null.
  if (typeof f.line === "number") out.line = f.line;
  if (typeof f.fix === "string" && f.fix !== "") out.fix = f.fix;
  const verify = scanned ? verifyCommand(scanned.scanPath, f, scanned.absentFiles) : undefined;
  if (verify !== undefined) out.verify = verify;
  return out;
}

/** Build the JSON result from a registry `TrustAnswer`. */
export function buildCheckJsonFromAnswer(
  answer: TrustAnswer,
  ecosystem?: "npm" | "pypi",
  requestedVersion?: string,
): CheckJsonResult {
  const out: CheckJsonResult = {
    name: answer.name,
    ...(ecosystem !== undefined ? { ecosystem } : {}),
    ...(requestedVersion !== undefined ? { requestedVersion, answerScope: "package" as const } : {}),
    source: "registry",
    found: answer.found,
  };
  if (answer.packageType !== undefined) out.packageType = answer.packageType;
  if (answer.verdict !== undefined) out.verdict = answer.verdict;
  if (answer.trustLevel !== undefined) out.trustLevel = answer.trustLevel;
  if (answer.trustScore !== undefined) out.trustScore = answer.trustScore;
  if (answer.scanStatus) out.scanStatus = answer.scanStatus;
  if (answer.lastScannedAt) out.lastScannedAt = answer.lastScannedAt;
  if (typeof answer.communityScans === "number") out.communityScans = answer.communityScans;
  const profile = readSecurityProfile(answer);
  if (profile) out.securityProfile = profile;
  // The registry lookup does not return raw HMA score/maxScore or per-finding
  // detail, so those fields are intentionally omitted on this path.
  return out;
}

/** The registry's answer as the scan path's `registry` object. */
function registryAnswerJson(
  answer: TrustAnswer,
  requestedVersion: string | undefined,
): CheckJsonRegistryAnswer {
  const out: CheckJsonRegistryAnswer = {};
  if (answer.verdict !== undefined) out.verdict = answer.verdict;
  if (answer.trustLevel !== undefined) out.trustLevel = answer.trustLevel;
  if (answer.trustScore !== undefined) out.trustScore = answer.trustScore;
  if (answer.scanStatus) out.scanStatus = answer.scanStatus;
  if (answer.lastScannedAt) out.lastScannedAt = answer.lastScannedAt;
  if (requestedVersion !== undefined) out.answerScope = "package";
  return out;
}

/** The counts the text Checks line prints, read as formatScanResult reads them. */
function checksJson(scan: ScanResult): NonNullable<CheckJsonResult["checks"]> {
  const staticCount =
    scan.scan.staticChecksEvaluated ?? scan.scan.checksEvaluated ?? (scan.scan.findings ?? []).length;
  if (scan.scan.staticOnly) return { static: staticCount, semanticLayer: "not-run" };
  const semantic = scan.scan.semanticCount;
  if (semantic === undefined) return { static: staticCount, semanticLayer: "not-reported" };
  return { static: staticCount, semantic, semanticLayer: "ran" };
}

/** What the scan path knows besides the scan: the registry's answer or its failure. */
export interface ScanJsonContext {
  registry?: TrustAnswer;
  registryError?: string;
  /** The version or tag the target gave. */
  requestedVersion?: string;
}

/**
 * Build the JSON result from a local `ScanResult`. `scanned` is given for
 * `check --scan-path`, whose findings name files in a directory that is
 * still on disk; `context` for a downloaded package, whose registry lookup
 * ran beside the scan.
 */
export function buildCheckJsonFromScan(
  scan: ScanResult,
  ecosystem?: "npm" | "pypi",
  scanned?: ScannedDirectory,
  context: ScanJsonContext = {},
): CheckJsonResult {
  const registryFields: Pick<CheckJsonResult, "registry" | "registryError"> = {};
  if (context.registry?.found) {
    registryFields.registry = registryAnswerJson(context.registry, context.requestedVersion);
  }
  if (context.registryError !== undefined) registryFields.registryError = context.registryError;
  // A scan that read 0 files and found none it could not read measured
  // nothing: the not-scored shape, as the out-of-scope answer uses, with the
  // count that makes it so. A scan whose files could not be read keeps its
  // score and the findings that name them.
  const version = scan.packageVersion !== undefined ? { version: scan.packageVersion } : {};
  if (nothingToScan(scan.scan)) {
    return {
      name: scan.packageName,
      ...(ecosystem !== undefined ? { ecosystem } : {}),
      ...version,
      source: "scan",
      found: true,
      scored: false,
      notScoredReason: "nothing to scan: the scanner read 0 files",
      filesExamined: 0,
      ...registryFields,
    };
  }
  const out: CheckJsonResult = {
    name: scan.packageName,
    ...(ecosystem !== undefined ? { ecosystem } : {}),
    ...version,
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
  if (failed.length > 0) out.findings = failed.map((f) => mapFinding(f, scanned));
  if (scan.scan.filesExamined !== undefined) out.filesExamined = scan.scan.filesExamined;
  out.checks = checksJson(scan);
  if (scan.notCounted !== undefined && scan.notCounted.length > 0) out.notCounted = scan.notCounted;
  Object.assign(out, registryFields);
  return out;
}

/** Convenience union builder. */
export function buildCheckJson(
  input:
    | {
        kind: "registry";
        answer: TrustAnswer;
        ecosystem?: "npm" | "pypi";
        requestedVersion?: string;
      }
    | ({ kind: "scan"; scan: ScanResult; ecosystem?: "npm" | "pypi" } & Partial<ScannedDirectory> &
        ScanJsonContext),
): CheckJsonResult {
  if (input.kind === "registry") {
    return buildCheckJsonFromAnswer(input.answer, input.ecosystem, input.requestedVersion);
  }
  const scanned =
    input.scanPath !== undefined
      ? { scanPath: input.scanPath, absentFiles: input.absentFiles ?? new Set<string>() }
      : undefined;
  const { scan, ecosystem, registry, registryError, requestedVersion } = input;
  return buildCheckJsonFromScan(scan, ecosystem, scanned, {
    registry,
    registryError,
    requestedVersion,
  });
}
