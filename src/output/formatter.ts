/**
 * Output formatting for trust query results.
 * Visual design aligned with hackmyagent CLI:
 *   - Score meter with colored bar
 *   - Section dividers
 *   - Severity-colored finding borders
 *   - Actionable next steps
 */

import chalk from "chalk";
import {
  scoreMeter,
  miniMeter,
  divider,
  normalizeVerdict,
  verdictColor,
  trustLevelLabel,
  trustLevelColor,
  trustLevelLegend,
  scoreColor,
  formatScanAge,
  renderObservationsBlock,
  renderCheckBlock,
  renderNotFoundBlock,
  renderNextSteps,
  buildCategorySummaries,
  type CategorizableFinding,
  type CheckBlockInput,
  type CheckTone,
  type NextStepsCta,
  type NotFoundBlockInput,
  type NotFoundTone,
} from "@opena2a/cli-ui";
import { buildScoreAwareVerdict, type LeadFinding } from "./score-aware-verdict.js";
import { verifyCommand } from "./finding-location.js";
import {
  hasRecordedIssues,
  readSecurityProfile,
  type RegistrySecurityProfile,
} from "./security-profile.js";
import { capLength, sanitizeRegistryValue, stripControlCharacters } from "./sanitize.js";
import { citeCommandsInText } from "./registry-command.js";
import { trustGate, type TrustGate } from "./trust-gate.js";
import { mapScanStatusForMeter } from "@opena2a/check-core";
import { classify, tierLabel } from "@opena2a/ai-classifier";
import type { Tier } from "@opena2a/ai-classifier";
import type { TrustAnswer, BatchResponse } from "@opena2a/registry-client";
import type { ScanResult } from "../scanner/index.js";
import { nothingToScan } from "../scanner/hma.js";
import { findAuditFile } from "../utils/audit-file.js";
import { checkCitation } from "../utils/cli-prefix.js";
import { shellArg } from "../utils/shell-arg.js";

// ── Visual helpers ─────────────────────────────────────────────���──────

/**
 * The scan status lowercased and trimmed. A value that is not a string (a
 * number, a boolean, an object) is read as no scan status: the registry
 * answer is remote data, whatever its declared type says.
 */
function normalizeScanStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  return status.toLowerCase().trim();
}

/**
 * mapScanStatusForMeter for a scan status as the registry sent it. The shared
 * helper calls toLowerCase on any truthy value, so a number such as 5 or an
 * object throws there; here such a value gets no meter, as a missing status
 * gets none.
 */
function meterScanStatus(status: unknown): ReturnType<typeof mapScanStatusForMeter> {
  return mapScanStatusForMeter(normalizeScanStatus(status));
}

/** The scan status as the text output prints it: trimmed, or undefined when it is not a string. */
function scanStatusText(status: unknown): string | undefined {
  return typeof status === "string" ? status.trim() : undefined;
}

/**
 * The answer with a scan status that is not a string read as none, so every
 * column and line of a batch table that reads the scan status reads a string
 * or undefined.
 */
function withStringScanStatus(answer: TrustAnswer): TrustAnswer {
  return answer.scanStatus === undefined || typeof answer.scanStatus === "string"
    ? answer
    : { ...answer, scanStatus: undefined };
}

// ── ai-trust-specific helpers ─────────────────────────────────────────

/**
 * True when the scan status names a finished scan, so the score is a
 * measurement: a status the `check` meter accepts (mapScanStatusForMeter), or
 * `local` for a package `audit --scan-missing` scanned on this machine. An
 * empty, pending, in-progress or unrecognized status has no score behind it.
 */
function hasScore(scanStatus?: string): boolean {
  const status = normalizeScanStatus(scanStatus);
  return status === "local" || mapScanStatusForMeter(status) !== undefined;
}

function formatScore(trustScore: number, scanStatus?: string): string {
  const status = normalizeScanStatus(scanStatus);
  if (status === "error") return "Scan error";
  if (status === "failed") return "Scan failed";
  if (!hasScore(status)) return "Not scanned";
  return `${Math.round(trustScore * 100)}/100`;
}

/**
 * The 0-1 trust score as a whole number out of 100, or undefined when the
 * value is not a finite number from 0 to 1. The meters cannot draw a value
 * off that scale (a negative fill throws), and the table does not guess what
 * scale such a value was meant on.
 */
function scorePercent(trustScore: unknown): number | undefined {
  if (typeof trustScore !== "number" || !Number.isFinite(trustScore)) return undefined;
  if (trustScore < 0 || trustScore > 1) return undefined;
  return Math.round(trustScore * 100);
}

function isScanErrorStatus(scanStatus?: string): boolean {
  const status = normalizeScanStatus(scanStatus);
  return status === "error" || status === "failed";
}

function scanStatusColor(status?: string): (text: string) => string {
  switch (normalizeScanStatus(status)) {
    case "passed":
      return chalk.green;
    case "warnings":
      return chalk.yellow;
    case "failed":
    case "error":
      return chalk.red;
    case "local":
      return chalk.cyan;
    default:
      return chalk.dim;
  }
}

// ── Tier partitioning (ai-trust's scope boundary) ─────────────────────

/**
 * Split batch results into AI-native (Tier 1), unrelated (Tier 3), and
 * unknown groups using @opena2a/ai-classifier. ai-trust only shows trust
 * data for native packages; unrelated packages get an HMA CTA footer.
 *
 * A package scanned locally by `audit --scan-missing` (scanStatus "local")
 * is always in scope: it carries no packageType, so the classifier alone
 * would file it as unknown (or, for a library-like name, unrelated) and
 * hide the verdict the user just asked for.
 */
function partitionByTier(results: TrustAnswer[]): {
  native: TrustAnswer[];
  unrelated: TrustAnswer[];
  unknown: TrustAnswer[];
} {
  const native: TrustAnswer[] = [];
  const unrelated: TrustAnswer[] = [];
  const unknown: TrustAnswer[] = [];
  for (const r of results) {
    if (r.found && normalizeScanStatus(r.scanStatus) === "local") {
      native.push(r);
      continue;
    }
    const tier = classify({ name: r.name, packageType: r.packageType }).tier;
    if (tier === "native") native.push(r);
    else if (tier === "unrelated") unrelated.push(r);
    else unknown.push(r);
  }
  return { native, unrelated, unknown };
}

/**
 * Compact comma-separated preview of out-of-scope library names, shared by
 * the mixed batch footer and the all-library summary.
 */
function outOfScopeNamesLine(unrelated: TrustAnswer[]): string {
  const names = unrelated.map((r) => r.name);
  const preview = names.slice(0, 6).join(chalk.dim(", "));
  const more = names.length > 6 ? chalk.dim(` + ${names.length - 6} more`) : "";
  return `  ${chalk.dim(preview)}${more}`;
}

/**
 * The out-of-scope libraries the registry does not have, every one by name:
 * audit exits 2 for each, and the preview above may not show it.
 */
function notFoundLibrariesLines(unrelated: TrustAnswer[]): string[] {
  const names = unrelated.filter((r) => !r.found).map((r) => r.name);
  if (names.length === 0) return [];
  return [`  ${chalk.yellow("Not found in registry:")} ${names.join(", ")}`];
}

/**
 * The Unclassified section of a batch. Every name is listed: audit exits 2
 * for each one the registry does not have.
 */
function unclassifiedSectionLines(unknown: TrustAnswer[]): string[] {
  return [
    divider("Unclassified"),
    chalk.dim(`  Not in registry and not on the known-library list. Classify them:`),
    ...unknown.map((pkg) => `  ${chalk.yellow("│")} ${pkg.name}`),
  ];
}

/**
 * A batch answer for a package the registry has under a type other than the
 * one `batch --type` asked for. It is the registry's answer, `found`
 * included; `excludedByType` marks it, and the text output lists it in the
 * Type mismatch section instead of the trust table.
 */
export type BatchAnswer = TrustAnswer & { excludedByType?: boolean };

function isExcludedByType(answer: TrustAnswer): boolean {
  return (answer as BatchAnswer).excludedByType === true;
}

/** The names of excluded packages by the type the registry has them under. */
function namesByRegisteredType(excluded: TrustAnswer[]): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const pkg of excluded) {
    const registered = pkg.packageType ?? "";
    byType.set(registered, [...(byType.get(registered) ?? []), pkg.name]);
  }
  return byType;
}

/** The header part that counts the packages `--type` excluded. */
function excludedByTypeText(count: number, type?: string): string {
  return `${count} excluded by --type${type ? ` ${type}` : ""}`;
}

/**
 * The Type mismatch section of a batch: each package `--type` excluded,
 * under the type the registry has it as. Every name is listed: batch exits 2
 * for each one.
 */
function typeMismatchSectionLines(excluded: TrustAnswer[], type?: string): string[] {
  if (excluded.length === 0) return [];
  const lines = [divider("Type mismatch")];
  for (const [registered, names] of namesByRegisteredType(excluded)) {
    const subject = names.length === 1 ? "This package is" : "These packages are";
    const requested = type ? `, not ${type}` : "";
    lines.push(chalk.dim(`  ${subject} registered as ${registered}${requested}:`));
    lines.push(...names.map((name) => `  ${chalk.yellow("│")} ${name}`));
  }
  return lines;
}

/** The batch command that looks excluded packages up by their registered type, one per type. */
function typeMismatchCommands(excluded: TrustAnswer[]): string[] {
  return [...namesByRegisteredType(excluded)].map(
    ([registered, names]) =>
      `ai-trust batch ${names.map(shellArg).join(" ")} --type ${shellArg(registered)}`
  );
}

/**
 * The scanner's fix text names each OpenA2A CLI by its command
 * (`hackmyagent secure --fix`, `opena2a protect .`). A global install of
 * ai-trust puts none of them on PATH, so show the `npx <package> ...` form the
 * Verdict and Next Steps lines already use (`npx opena2a-cli protect .`).
 */
function runnableFix(fix: string): string {
  return citeCommandsInText(fix);
}

/**
 * The Fix line of a finding the scanner gave no fix for: it says so, and
 * names the scanner command that describes the check.
 */
function noFixSupplied(checkId: string): string {
  const id = stripControlCharacters(checkId).trim();
  if (id === "") return "none supplied by the scanner";
  return `none supplied by the scanner for ${id}; background: npx hackmyagent explain ${shellArg(id)}`;
}

// ── Formatters ────────────────────────────────────────────────────────

// Color tone painters \u2014 CLIs own chalk per the cli-ui contract.
function paintCheckTone(tone: CheckTone, s: string): string {
  if (tone === "good") return chalk.green(s);
  if (tone === "warning") return chalk.yellow(s);
  if (tone === "critical") return chalk.red(s);
  if (tone === "dim") return chalk.dim(s);
  return s;
}

function paintNotFoundTone(tone: NotFoundTone, s: string): string {
  if (tone === "good") return chalk.green(s);
  if (tone === "warning") return chalk.yellow(s);
  if (tone === "critical") return chalk.red(s);
  if (tone === "dim") return chalk.dim(s);
  return s;
}

const CHECK_LABEL_WIDTH = 10;


function buildCheckCtas(
  answer: TrustAnswer,
  isScanError: boolean,
  ecosystem: "npm" | "pypi",
  version: string | undefined,
): NextStepsCta[] {
  const normalized = normalizeVerdict(answer.verdict);
  const meterGate = meterScanStatus(answer.scanStatus);
  const isUnscanned = meterGate === undefined && !isScanError;

  const ctas: NextStepsCta[] = [];
  // The name is the registry's string: quoted, so it stays one argument. A
  // PyPI answer keeps its pip: prefix, so the scan is of the same package,
  // and a `<name>@<version>` target keeps its version, so the scan is of
  // the version asked about.
  const name = version === undefined ? answer.name : `${answer.name}@${version}`;
  const target = ecosystem === "pypi" ? `pip:${name}` : name;
  const checkCmd = `${checkCitation()} ${shellArg(target)}`;
  if (isScanError) {
    ctas.push({
      label: "Rescan",
      command: checkCmd,
      primary: true,
    });
  } else if (isUnscanned || answer.trustLevel <= 2) {
    ctas.push({
      label: "Scan locally",
      command: checkCmd,
      primary: true,
    });
  } else if (normalized === "blocked" || normalized === "warning") {
    ctas.push({
      label: "Deep scan",
      command: checkCmd,
      primary: true,
    });
  } else {
    ctas.push({
      label: "Fresh scan",
      command: checkCmd,
      primary: true,
    });
  }
  const audit = auditCta();
  if (audit) ctas.push(audit);
  return ctas;
}

const MAX_LISTED_CVES = 5;
// Longest advisory identifier printed whole; a longer entry is cut and marked.
const MAX_ADVISORY_ID_LENGTH = 40;

/**
 * Headline for a passed verdict whose registry scan status is `warnings` when
 * no profile came back or the profile records no critical or high finding and
 * no CVE. "No known issues" would contradict the scan status; the verdict and
 * exit code stay the registry's.
 */
const PASSED_WITH_SCAN_WARNINGS = "Passed, but the registry's scan reported warnings";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Headline for a passed verdict whose registry profile records findings or
 * CVEs. "No known issues" would contradict the counts printed below it; the
 * verdict and exit code stay the registry's.
 */
function passedWithRecordedIssuesText(profile: RegistrySecurityProfile): string {
  const critical = profile.criticalCount ?? 0;
  const high = profile.highCount ?? 0;
  const severities: string[] = [];
  if (critical > 0) severities.push(`${critical} critical`);
  if (high > 0) severities.push(`${high} high`);
  const parts: string[] = [];
  if (severities.length > 0) {
    // "2 critical and 1 high finding": the noun agrees with the last count.
    const last = high > 0 ? high : critical;
    parts.push(`${severities.join(" and ")} finding${last === 1 ? "" : "s"}`);
  }
  if (profile.knownCves.length > 0) {
    parts.push(plural(profile.knownCves.length, "known CVE"));
  }
  return `Passed, but the registry recorded ${parts.join(", plus ")}`;
}

/** Beside a recorded count: the registry's answer names no finding. */
const DETAILS_NOT_RETURNED = "(details not returned)";

/** "3 critical", or "critical not reported" for a count the registry did not report. */
function countText(count: number | undefined, severity: string): string {
  return count === undefined ? `${severity} not reported` : `${count} ${severity}`;
}

/** "Findings" and "CVEs" lines from the registry's security profile. */
function securityProfileLines(
  profile: RegistrySecurityProfile,
  scanStatus: unknown,
): string[] {
  const { criticalCount, highCount } = profile;
  const counts = [countText(criticalCount, "critical"), countText(highCount, "high")];
  // The answer carries counts, not the findings behind them: the last count
  // above zero says so. The Next Steps scan is how to measure them now.
  if ((highCount ?? 0) > 0) counts[1] += ` ${DETAILS_NOT_RETURNED}`;
  else if ((criticalCount ?? 0) > 0) counts[0] += ` ${DETAILS_NOT_RETURNED}`;
  const status = scanStatusText(scanStatus);
  if (status) counts.push(`scan status ${status}`);
  // Green only when both counts were reported and both are zero.
  let findingsTone: CheckTone;
  if ((criticalCount ?? 0) > 0) findingsTone = "critical";
  else if ((highCount ?? 0) > 0) findingsTone = "warning";
  else if (criticalCount === undefined || highCount === undefined) findingsTone = "default";
  else findingsTone = "good";

  let cves: string;
  let cvesTone: CheckTone;
  if (profile.knownCves.length === 0) {
    cves = "none recorded";
    cvesTone = "dim";
  } else {
    const shown = profile.knownCves
      .slice(0, MAX_LISTED_CVES)
      .map((id) => capLength(id, MAX_ADVISORY_ID_LENGTH))
      .join(", ");
    const more = profile.knownCves.length - MAX_LISTED_CVES;
    cves = more > 0 ? `${shown} +${more} more` : shown;
    cvesTone = "critical";
  }

  return [
    `  ${"Findings".padEnd(CHECK_LABEL_WIDTH)}${paintCheckTone(findingsTone, counts.join(" · "))}`,
    `  ${"CVEs".padEnd(CHECK_LABEL_WIDTH)}${paintCheckTone(cvesTone, cves)}`,
  ];
}

/**
 * The age of the registry's scan ("228 days ago (stale)"), or null when the
 * answer carries no date or one that does not parse.
 */
function registryScanAge(lastScannedAt: string | undefined): string | null {
  if (!lastScannedAt) return null;
  if (Number.isNaN(new Date(lastScannedAt).getTime())) return null;
  return formatScanAge(lastScannedAt);
}

/**
 * Trust line of an answer that carries a scan date under a scan status that is
 * not a finished one (pending, not_applicable, empty, unrecognized, or a value
 * that is not a string). The score is not shown, and the line names the status
 * the registry sent, or says it sent none or one that is not a string, and the
 * age of its last recorded scan, the age the header prints, instead of saying
 * "not scanned" under that header.
 */
function unfinishedScanTrustText(scanStatus: unknown, age: string): string {
  const status = scanStatusText(scanStatus);
  let reason: string;
  if (status) {
    reason = `the registry's scan status is ${status}`;
  } else if (status === undefined && scanStatus !== undefined && scanStatus !== null) {
    reason = "the registry's scan status is not a string";
  } else {
    reason = "the registry's answer has no scan status";
  }
  return `score not shown: ${reason} · last recorded scan ${age}`;
}

/**
 * The name of the registry's trust level: the shared label for a whole number
 * ("Listed", or "Unknown (7)" off the 0-4 scale), and undefined for any other
 * value, which the text output prints as "-". The shared label looks the name
 * up with the value as sent, so a string such as "\t1" or a fraction has none.
 */
function trustLevelName(level: unknown): string | undefined {
  return typeof level === "number" && Number.isInteger(level) ? trustLevelLabel(level) : undefined;
}

/** Level line of an answer whose trust level is not a whole number: "-" and why. */
function unreadableLevelText(level: unknown): string {
  const reason =
    level === undefined || level === null
      ? "the registry's answer has no trust level"
      : "the registry's trust level is not a whole number";
  return `- (${reason})`;
}

/**
 * A difference between the registry's score and this run's score, in points
 * on the 0-100 scale, above which the scan output sets the two side by side.
 */
const REGISTRY_GAP_POINTS = 20;

/**
 * "Registry 79/100 (scanned 228 days ago) vs this scan 100/100 (today)" when
 * the registry's score and the scan's differ by more than REGISTRY_GAP_POINTS,
 * or null. No line when either side has no score: a failed or pending registry
 * scan, a registry score off the 0-1 scale, or a scan with nothing to analyze.
 * The line states the two measurements and their dates, not a cause.
 */
function registryGapLine(registryAnswer: TrustAnswer, result: ScanResult): string | null {
  const answer = sanitizeRegistryValue(registryAnswer);
  if (!answer.found || meterScanStatus(answer.scanStatus) === undefined) return null;
  const registryScore = scorePercent(answer.trustScore);
  if (registryScore === undefined) return null;
  const { score, maxScore } = result.scan;
  if (hasNoAnalyzableSurfaces(result) || !(maxScore > 0)) return null;
  const scanScore = Math.round((score / maxScore) * 100);
  if (Math.abs(registryScore - scanScore) <= REGISTRY_GAP_POINTS) return null;
  const age = registryScanAge(answer.lastScannedAt);
  // The date sits in parentheses here, so the age drops its own "(stale)".
  const registryDate = age ? `scanned ${age.replace(/ \(stale\)$/, "")}` : "scan date not recorded";
  return `Registry ${registryScore}/100 (${registryDate}) vs this scan ${scanScore}/100 (today)`;
}

/**
 * True when formatScanResult, given the registry's answer as its `registry`
 * option, prints the registry's score beside this scan's: a scan that read 0
 * files prints no score, and registryGapLine says when the other scans do.
 */
export function showsRegistryScore(registryAnswer: TrustAnswer, result: ScanResult): boolean {
  return !nothingToScan(result.scan) && registryGapLine(registryAnswer, result) !== null;
}

/**
 * True when the scan executed no static check and found nothing, static or
 * semantic: the package had no analyzable surfaces, so its score is not a
 * measurement.
 */
function hasNoAnalyzableSurfaces(result: ScanResult): boolean {
  const failed = result.scan.findings.filter((f) => !f.passed).length;
  const semanticCount =
    result.semanticFindings?.length ?? result.scan.semanticFindings?.length ?? 0;
  return result.scan.checksEvaluated === 0 && failed === 0 && semanticCount === 0;
}

/**
 * The "Full project audit" next step, or null when the current directory
 * holds no file `audit` reads: a command that would fail is not a next step.
 */
function auditCta(): NextStepsCta | null {
  const file = findAuditFile();
  if (!file) return null;
  return { label: "Full project audit", command: `ai-trust audit ${file}` };
}

function renderNextStepsLines(ctas: NextStepsCta[]): string[] {
  const { lines } = renderNextSteps({ ctas });
  return lines.map((s) => {
    const bullet = s.tone === "good" ? chalk.green(s.bullet) : chalk.cyan(s.bullet);
    const label = s.tone === "good" ? chalk.bold(s.label) : chalk.cyan(s.label);
    return `  ${bullet} ${label}  ${chalk.dim(s.command)}`;
  });
}

/**
 * Text after a package name that says which ecosystem a `pip:<name>` target
 * was checked under, in the not-found block's form (`requests (pypi)`).
 * npm, the ecosystem of a name without a prefix, adds nothing.
 */
export function ecosystemSuffix(ecosystem: "npm" | "pypi"): string {
  return ecosystem === "pypi" ? " (pypi)" : "";
}

/**
 * Text after the name of a scanned `<name>@<tag>` or `<name>@<range>` that
 * names the version it resolved to, read from the downloaded package's
 * manifest (`is-odd@latest (3.0.1)`). Nothing when the target gave no
 * version, gave the version that was downloaded, or the manifest has none.
 */
function resolvedVersionSuffix(result: ScanResult): string {
  const { requestedVersion, packageVersion } = result;
  if (requestedVersion === undefined || packageVersion === undefined) return "";
  return packageVersion === requestedVersion ? "" : ` (${packageVersion})`;
}

export interface FormatCheckResultOptions {
  /**
   * The version or tag a `<name>@<version>` target gave. The registry answers
   * for the package; the Next Steps scan is of this version.
   */
  version?: string;
}

export function formatCheckResult(
  registryAnswer: TrustAnswer,
  ecosystem: "npm" | "pypi" = "npm",
  opts: FormatCheckResultOptions = {},
): string {
  // Registry strings are remote data: control characters are removed first.
  const answer = sanitizeRegistryValue(registryAnswer);
  if (!answer.found) {
    return formatNotFound({
      pkg: answer.name,
      ecosystem,
    });
  }

  const scanStatusForMeter = meterScanStatus(answer.scanStatus);
  // The shared meter reads a score above 1 as out of 100 and throws on a
  // negative or infinite one. A score that is not from 0 to 1 gets no meter:
  // the Trust line shows --, as batch and audit do.
  const unreadableScore =
    scanStatusForMeter !== undefined && scorePercent(answer.trustScore) === undefined;
  // A date that does not parse is not a scan date: no "Last scan" line for it.
  const scanAge = registryScanAge(answer.lastScannedAt);
  const block = renderCheckBlock({
    name: answer.name,
    packageType: answer.packageType,
    trustLevel: answer.trustLevel,
    trustScore: answer.trustScore,
    verdict: answer.verdict,
    scanStatus: unreadableScore ? undefined : scanStatusForMeter,
    communityScans: answer.communityScans,
    lastScannedAt: scanAge ? answer.lastScannedAt : undefined,
  });

  const isScanError = isScanErrorStatus(answer.scanStatus);
  const profile = readSecurityProfile(answer);
  const out: string[] = [];

  // Header. "scan date not recorded" is for a scan without a date; a package
  // whose scan status names no scan, finished or failed, was not scanned.
  out.push("");
  const meta = [...block.header.meta];
  const neverScanned = scanStatusForMeter === undefined && !isScanError;
  meta.push(scanAge ? `scanned ${scanAge}` : neverScanned ? "not scanned" : "scan date not recorded");
  const headerMeta = meta.length > 0 ? `  ${chalk.dim(meta.join(" \u00b7 "))}` : "";
  out.push(
    `  ${chalk.bold.white(block.header.name)}${ecosystemSuffix(ecosystem)}${headerMeta}`,
  );

  // Verdict
  const vc = verdictColor(answer.verdict);
  if (isScanError) {
    out.push(`  ${chalk.bold(chalk.red("Scan failed \u2014 score is unreliable"))}`);
  } else if (
    profile &&
    normalizeVerdict(answer.verdict) === "safe" &&
    hasRecordedIssues(profile)
  ) {
    out.push(`  ${chalk.bold(chalk.yellow(passedWithRecordedIssuesText(profile)))}`);
  } else if (
    normalizeVerdict(answer.verdict) === "safe" &&
    scanStatusForMeter === "warnings"
  ) {
    out.push(`  ${chalk.bold(chalk.yellow(PASSED_WITH_SCAN_WARNINGS))}`);
  } else {
    out.push(`  ${chalk.bold(vc(block.verdict.text))}`);
  }

  // Body lines
  out.push("");
  for (const line of block.lines) {
    if (line.label === "Trust" && isScanError) {
      out.push(
        `  ${"Trust".padEnd(CHECK_LABEL_WIDTH)}${chalk.red.bold("Scan failed")} ${chalk.dim(
          "\u2014 rescan to get an accurate score"
        )}`
      );
      continue;
    }
    if (line.label === "Trust" && unreadableScore) {
      out.push(
        `  ${"Trust".padEnd(CHECK_LABEL_WIDTH)}-- ${chalk.dim(
          "(the registry's score is not a number from 0 to 1)"
        )}`
      );
      continue;
    }
    // A scan status that is not a finished one shows no score, but a recorded
    // date means the registry scanned the package: no "not scanned" under the
    // header's date.
    if (line.label === "Trust" && scanStatusForMeter === undefined && !isScanError && scanAge) {
      out.push(
        `  ${"Trust".padEnd(CHECK_LABEL_WIDTH)}${chalk.dim(
          unfinishedScanTrustText(answer.scanStatus, scanAge)
        )}`
      );
      continue;
    }
    // The shared block looks the level's name up with the value as sent, so a
    // string such as "\t1" or a fraction prints "undefined" there.
    if (line.label === "Level" && !Number.isInteger(answer.trustLevel)) {
      out.push(
        `  ${"Level".padEnd(CHECK_LABEL_WIDTH)}${chalk.dim(unreadableLevelText(answer.trustLevel))}`
      );
      continue;
    }
    const label = line.label.padEnd(CHECK_LABEL_WIDTH);
    out.push(`  ${label}${paintCheckTone(line.tone, line.value)}`);
  }

  // Registry finding counts and known CVEs. Omitted on a failed scan, whose
  // counts are as unreliable as its score, and when no profile came back.
  if (profile && !isScanError) {
    out.push(...securityProfileLines(profile, answer.scanStatus));
  }

  // Dependencies
  if (answer.dependencies && answer.dependencies.totalDeps > 0) {
    const deps = answer.dependencies;
    const depParts: string[] = [`${deps.totalDeps} total`];
    if (deps.vulnerableDeps > 0)
      depParts.push(chalk.red(`${deps.vulnerableDeps} vulnerable`));
    if (deps.minTrustLevel !== undefined)
      depParts.push(`min trust ${deps.minTrustLevel}/4`);
    out.push(`  ${"Deps".padEnd(CHECK_LABEL_WIDTH)}${depParts.join(chalk.dim(" \u00b7 "))}`);
  }

  // Next Steps
  out.push(divider("Next Steps"));
  out.push(...renderNextStepsLines(buildCheckCtas(answer, isScanError, ecosystem, opts.version)));

  out.push("");
  return out.join("\n");
}

export interface NotFoundInput extends NotFoundBlockInput {
  /**
   * The `--type` the registry was asked with. The registry's miss is for that
   * type, so the header names it beside the ecosystem: `(npm, type a2a_agent)`.
   */
  type?: string;
}

/**
 * Render a "package not found" block via cli-ui renderNotFoundBlock.
 * Closes F2 (divergent not-found shapes) and F3 (raw git exit codes).
 */
export function formatNotFound(input: NotFoundInput): string {
  const { type, ...block } = input;
  const qualifiers = [block.ecosystem, type ? `type ${type}` : undefined]
    .filter((part) => part !== undefined && part !== "")
    .join(", ");
  const { header, lines: bodyLines } = renderNotFoundBlock({
    ...block,
    ecosystem: qualifiers === "" ? undefined : qualifiers,
  });
  const out: string[] = [""];
  out.push(`  ${chalk.yellow.bold(header.text)}`);
  if (bodyLines.length > 0) {
    out.push("");
    for (const l of bodyLines) {
      if (l.label) {
        out.push(
          `  ${chalk.dim(l.label.padEnd(CHECK_LABEL_WIDTH))}${paintNotFoundTone(l.tone, l.value)}`
        );
      } else {
        out.push(`  ${paintNotFoundTone(l.tone, l.value)}`);
      }
    }
  }
  out.push(divider("Next Steps"));
  // A PyPI miss keeps its pip: prefix, so the scan is of the same package and
  // not of the npm package of that name.
  const target = input.ecosystem === "pypi" ? `pip:${input.pkg}` : input.pkg;
  const ctas: NextStepsCta[] = [
    {
      label: "Scan locally",
      // check scans by default; --scan-if-missing is a no-op.
      command: `${checkCitation()} ${shellArg(target)}`,
      primary: true,
    },
  ];
  const audit = auditCta();
  if (audit) ctas.push(audit);
  out.push(...renderNextStepsLines(ctas));
  out.push("");
  return out.join("\n");
}

/**
 * What `audit` tells formatBatchResults about the file it read, `batch`
 * about its `--type`, and the width of the terminal stdout writes to.
 */
export interface BatchResultsOptions {
  /**
   * The dependency file `audit` read. The next step for a dependency the
   * registry does not have is then `ai-trust audit <file> --scan-missing`,
   * in the Summary and in the Next Steps; without a file the Summary's is
   * `ai-trust check <name>` for the first one.
   */
  file?: string;
  /**
   * `audit` already scanned the dependencies the registry does not have
   * (`--scan-missing`, or yes at its prompt). The next step for one that is
   * still missing is then to check it, not to run the same scan again.
   */
  scannedMissing?: boolean;
  /** The ecosystem the names were looked up in: a PyPI name is checked as `pip:<name>`. */
  ecosystem?: "npm" | "pypi";
  /** The `batch --type` value, named where a package it excluded is listed. */
  type?: string;
  /**
   * The width of the terminal stdout writes to, or undefined when stdout is
   * not a terminal (a pipe or a file). On a terminal a name longer than the
   * PACKAGE column is cut; without one every name is printed whole.
   */
  terminalWidth?: number;
}

/**
 * The Summary of a batch that fails the trust gate: its divider, the line
 * that says what makes audit or batch exit 2, naming every dependency, and
 * the command to run next. None when the gate passes.
 */
function gateFailureLines(
  gate: TrustGate,
  minTrust: number,
  opts: BatchResultsOptions
): string[] {
  if (gate.passed) return [];
  const notFound = gate.notFound.map((r) => String(r.name));
  const below = gate.belowThreshold.map((r) => String(r.name));
  const excluded = gate.excludedByType.map((r) => String(r.name));
  const reasons: string[] = [];
  if (notFound.length > 0) {
    const one = notFound.length === 1;
    reasons.push(
      `${notFound.length} ${one ? "dependency is" : "dependencies are"} not in the registry and ${
        one ? "was" : "were"
      } not scanned: ${notFound.join(", ")}`
    );
  }
  if (below.length > 0) {
    const count =
      reasons.length > 0
        ? `${below.length}`
        : `${below.length} ${below.length === 1 ? "dependency is" : "dependencies are"}`;
    reasons.push(`${count} below minimum trust level ${minTrust}: ${below.join(", ")}`);
  }
  if (excluded.length > 0) {
    const count =
      reasons.length > 0
        ? `${excluded.length}`
        : `${excluded.length} ${excluded.length === 1 ? "dependency is" : "dependencies are"}`;
    reasons.push(
      `${count} excluded by --type${opts.type ? ` ${opts.type}` : ""}: ${excluded.join(", ")}`
    );
  }
  let next: string;
  if (notFound.length > 0 && opts.file !== undefined && opts.scannedMissing !== true) {
    next = `ai-trust audit ${shellArg(opts.file)} --scan-missing`;
  } else if (notFound.length > 0 || below.length > 0) {
    const name = notFound[0] ?? below[0];
    next = `ai-trust check ${shellArg(opts.ecosystem === "pypi" ? `pip:${name}` : name)}`;
  } else {
    // Only packages --type excluded fail: look them up as the type the
    // registry has them under.
    next = typeMismatchCommands(gate.excludedByType)[0];
  }
  return [
    divider("Summary"),
    chalk.red.bold(`  Audit failed: ${reasons.join("; ")}`),
    `  ${chalk.cyan("Next:")} ${next}`,
  ];
}

/** The width of the label column of the batch Next Steps. */
const BATCH_STEP_LABEL_WIDTH = 19;

/** The most `ai-trust check <name>` commands one Next Steps line lists. */
const MAX_LISTED_CHECK_COMMANDS = 3;

/**
 * A Next Steps step with one `ai-trust check` command for each name, aligned
 * under the first, the first MAX_LISTED_CHECK_COMMANDS of them followed by a
 * count of the rest, which the sections above list. Names come from the
 * registry or a dependency file, so each is quoted for the shell.
 */
function checkCommandSteps(
  label: string,
  names: string[],
  ecosystem: "npm" | "pypi",
  labelWidth = BATCH_STEP_LABEL_WIDTH,
): string[] {
  const commands = names
    .slice(0, MAX_LISTED_CHECK_COMMANDS)
    .map((n) => `ai-trust check ${shellArg(ecosystem === "pypi" ? `pip:${n}` : n)}`);
  const rest = names.length - MAX_LISTED_CHECK_COMMANDS;
  if (rest > 0) commands.push(chalk.dim(`+ ${rest} more, listed above`));
  return commands.map((command, i) =>
    i === 0
      ? `  ${chalk.cyan(label)}${" ".repeat(Math.max(1, labelWidth - label.length))}${command}`
      : `  ${" ".repeat(labelWidth)}${command}`,
  );
}

/** A Next Steps step with one command. */
function commandStep(label: string, command: string, labelWidth = BATCH_STEP_LABEL_WIDTH): string {
  return `  ${chalk.cyan(label)}${" ".repeat(Math.max(1, labelWidth - label.length))}${command}`;
}

/** The visible width of a table cell: its length without color codes. */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function formatBatchResults(
  response: BatchResponse,
  minTrust: number,
  opts: BatchResultsOptions = {},
): string {
  const ecosystem = opts.ecosystem ?? "npm";
  const lines: string[] = [];
  // Registry strings are remote data: control characters are removed first,
  // and a scan status that is not a string is read as none.
  const results = sanitizeRegistryValue(response.results).map(withStringScanStatus);
  // A package --type excluded is listed under its registered type, outside
  // the tiers.
  const excluded = results.filter(isExcludedByType);
  const { native, unrelated, unknown } = partitionByTier(
    results.filter((r) => !isExcludedByType(r)),
  );
  const mismatchCommands = typeMismatchCommands(excluded);
  // audit and batch set their exit code from the same gate on the same
  // answers, so the Summary says the gate failed exactly when they exit 2.
  const gate = trustGate(response.results, minTrust);
  const gateFailure = gateFailureLines(gate, minTrust, opts);

  // Header: summarize the scope split before anything else so the user knows
  // how many of their dependencies are actually in ai-trust's scope.
  lines.push("");
  if (native.length === 0 && unrelated.length > 0) {
    // Edge case: nothing here is an AI package. Show a focused message and
    // route the user to HMA for general security scanning.
    const searched = response.meta.total - excluded.length;
    lines.push(
      chalk.bold(
        `  No AI packages found in ${searched} ${
          searched === 1 ? "dependency" : "dependencies"
        }`
      ) +
        (excluded.length > 0
          ? chalk.dim(` · ${excludedByTypeText(excluded.length, opts.type)}`)
          : "")
    );
    lines.push(
      chalk.dim(
        `  ai-trust covers MCP servers, A2A agents, skills, AI tools, and LLMs.`
      )
    );
    lines.push(
      chalk.dim(
        `  For general security scanning of libraries, use HackMyAgent.`
      )
    );
    lines.push(...gateFailure);
    lines.push(divider("Out of scope (libraries)"));
    lines.push(outOfScopeNamesLine(unrelated));
    lines.push(...notFoundLibrariesLines(unrelated));
    if (unknown.length > 0) {
      lines.push(...unclassifiedSectionLines(unknown));
    }
    lines.push(...typeMismatchSectionLines(excluded, opts.type));
    lines.push(divider("Next Steps"));
    lines.push(commandStep("General security scan:", "npx hackmyagent secure .", 24));
    if (unknown.length > 0) {
      lines.push(...checkCommandSteps("Check an AI package:", unknown.map((r) => r.name), ecosystem, 24));
    }
    for (const command of mismatchCommands) {
      lines.push(`  ${chalk.cyan("Look up by type:")}         ${command}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const headerParts: string[] = [
    `${native.length} AI ${native.length === 1 ? "package" : "packages"} audited`,
  ];
  if (unrelated.length > 0) {
    headerParts.push(
      chalk.dim(
        `${unrelated.length} ${unrelated.length === 1 ? "library" : "libraries"} out of scope`
      )
    );
  }
  if (unknown.length > 0) {
    headerParts.push(
      chalk.dim(`${unknown.length} unclassified`)
    );
  }
  if (excluded.length > 0) {
    headerParts.push(chalk.dim(excludedByTypeText(excluded.length, opts.type)));
  }
  lines.push(chalk.bold("  " + headerParts.join(chalk.dim(" · "))));

  // If we have no AI packages to show but some unknown or excluded ones,
  // render just those lists with a CTA for each.
  if (native.length === 0) {
    if (unknown.length > 0 || excluded.length > 0) {
      lines.push(...gateFailure);
      if (unknown.length > 0) {
        lines.push(divider("Unclassified packages"));
        lines.push(
          chalk.dim(
            "  These packages aren't registered as AI and aren't on the known-library allowlist."
          )
        );
        for (const pkg of unknown) {
          lines.push(`  ${chalk.yellow("\u2502")} ${pkg.name}`);
        }
      }
      lines.push(...typeMismatchSectionLines(excluded, opts.type));
      lines.push(divider("Next Steps"));
      lines.push(...checkCommandSteps("Classify individually:", unknown.map((r) => r.name), ecosystem, 23));
      for (const command of mismatchCommands) {
        lines.push(`  ${chalk.cyan("Look up by type:")} ${command}`);
      }
      lines.push(commandStep("General security scan:", "npx hackmyagent secure .", 23));
      lines.push("");
      return lines.join("\n");
    }
    // No native + no unrelated + no unknown + no excluded = empty result set
    lines.push(chalk.dim("  No packages to display."));
    lines.push("");
    return lines.join("\n");
  }

  // Tier 1 trust table — the main event.
  // Table header. On a terminal the PACKAGE column is 36 wide and a longer
  // name is cut; without one (a pipe or a file) the column fits the longest
  // name, printed whole. The SCAN column fits the longest scan status.
  const onTerminal = opts.terminalWidth !== undefined;
  const nameWidth = onTerminal
    ? 36
    : Math.max(36, ...native.map((r) => r.name.length + 2));
  const typeWidth = 14;
  const verdictWidth = 10;
  const levelWidth = 12;
  const scoreWidth = 16;
  const scanWidth = Math.max(
    10,
    ...native.filter((r) => r.found).map((r) => (r.scanStatus || "-").length + 2),
  );

  lines.push("");
  lines.push(
    chalk.dim("  ") +
      chalk.dim(
        "PACKAGE".padEnd(nameWidth) +
          "TYPE".padEnd(typeWidth) +
          "VERDICT".padEnd(verdictWidth) +
          "TRUST".padEnd(levelWidth) +
          "SCORE".padEnd(scoreWidth) +
          "SCAN".padEnd(scanWidth)
      )
  );
  lines.push(
    "  " +
      chalk.dim(
        "\u2500".repeat(
          nameWidth +
            typeWidth +
            verdictWidth +
            levelWidth +
            scoreWidth +
            scanWidth
        )
      )
  );

  for (const result of native) {
    const name = onTerminal ? capLength(result.name, nameWidth - 2) : result.name;

    if (!result.found) {
      lines.push(
        "  " +
          name.padEnd(nameWidth) +
          chalk.dim("-".padEnd(typeWidth)) +
          chalk.gray("NO DATA".padEnd(verdictWidth)) +
          chalk.dim("-".padEnd(levelWidth)) +
          chalk.dim("-".padEnd(scoreWidth)) +
          chalk.dim("-".padEnd(scanWidth))
      );
      continue;
    }

    const normalized = normalizeVerdict(result.verdict);
    const colorVerdict = verdictColor(result.verdict);
    const colorTrust = trustLevelColor(result.trustLevel);
    const scoreDisplay = formatScore(result.trustScore, result.scanStatus);
    const scoreVal = scorePercent(result.trustScore);
    const isScanError = isScanErrorStatus(result.scanStatus);

    // Score column: mini meter for scanned, text for error, and "--" with no
    // meter for a package with no score (not scanned, or a score off the 0-1
    // scale): an empty meter reads as a full one where color is off. The
    // cell is padded to the column, so SCAN lines up under its header.
    let scoreCell: string;
    if (isScanError) {
      scoreCell = chalk.red.bold("Error");
    } else if (scoreDisplay === "Not scanned" || scoreVal === undefined) {
      scoreCell = chalk.dim("--");
    } else {
      scoreCell = miniMeter(scoreVal);
    }
    scoreCell += " ".repeat(Math.max(2, scoreWidth - visibleLength(scoreCell)));

    // Color the scan status
    const statusText = result.scanStatus || "-";
    const coloredStatus = scanStatusColor(result.scanStatus)(statusText.padEnd(scanWidth));

    // A trust level that is not a whole number prints as the not-found row's "-".
    const levelName = trustLevelName(result.trustLevel);
    const levelCell =
      levelName === undefined
        ? chalk.dim("-".padEnd(levelWidth))
        : chalk.bold(colorTrust(levelName.padEnd(levelWidth)));

    lines.push(
      "  " +
        name.padEnd(nameWidth) +
        (result.packageType || "-").padEnd(typeWidth) +
        colorVerdict(normalized.toUpperCase().padEnd(verdictWidth)) +
        levelCell +
        scoreCell +
        coloredStatus
    );
  }

  // Summary. The gate covers every dependency; the lists below it give the
  // detail for the AI packages in the table.
  const belowThreshold = native.filter(
    (r) => r.found && r.trustLevel < minTrust
  );
  const notFound = native.filter((r) => !r.found);
  const errorScans = native.filter(
    (r) => r.found && isScanErrorStatus(r.scanStatus)
  );

  if (gateFailure.length > 0) {
    lines.push(...gateFailure);
    if (belowThreshold.length > 0 || notFound.length > 0 || errorScans.length > 0) {
      lines.push("");
    }
  } else if (errorScans.length > 0) {
    lines.push(divider("Summary"));
  } else {
    lines.push("");
  }

  if (belowThreshold.length > 0) {
    lines.push(
      chalk.yellow.bold(
        `  ${belowThreshold.length} package(s) below minimum trust level ${minTrust}:`
      )
    );
    for (const pkg of belowThreshold) {
      const tlc = trustLevelColor(pkg.trustLevel);
      const pkgScore = scorePercent(pkg.trustScore);
      // Same conditions that render "--" in the table: no scan, or a score
      // off the 0-1 scale, gives no number.
      let scoreSection: string;
      if (isScanErrorStatus(pkg.scanStatus)) {
        scoreSection = chalk.red.bold("Error") + chalk.dim(" \u2014 rescan for accurate score");
      } else if (formatScore(pkg.trustScore, pkg.scanStatus) === "Not scanned") {
        scoreSection = chalk.dim("not scanned");
      } else if (pkgScore === undefined) {
        scoreSection = chalk.dim("score unavailable");
      } else {
        scoreSection = scoreMeter(pkgScore);
      }
      // The gate compares the level with `<`, so a string such as "\t1" counts
      // below level 2 there; it has no name here.
      const levelName = trustLevelName(pkg.trustLevel);
      const levelSection =
        levelName === undefined
          ? chalk.dim("level unavailable")
          : `${tlc(levelName)} ${chalk.dim(`(${pkg.trustLevel}/4)`)}`;
      lines.push(
        `  ${chalk.yellow("\u2502")} ${pkg.name}  ${scoreSection}  ${levelSection}`
      );
    }
  }

  if (errorScans.length > 0) {
    lines.push(
      chalk.red.bold(
        `  ${errorScans.length} package(s) with scan errors:`
      )
    );
    for (const pkg of errorScans) {
      lines.push(
        `  ${chalk.red("\u2502")} ${pkg.name}  ${chalk.red.bold("Error")} ${chalk.dim("\u2014 rescan for accurate score")}`
      );
    }
  }

  if (notFound.length > 0) {
    lines.push(
      chalk.yellow.bold(
        `  ${notFound.length} package(s) not found in registry:`
      )
    );
    for (const pkg of notFound) {
      lines.push(`  ${chalk.yellow("\u2502")} ${pkg.name}`);
    }
  }

  const foundNative = native.filter((r) => r.found).length;
  if (gate.passed && errorScans.length === 0 && foundNative > 0) {
    lines.push(
      chalk.green.bold(
        foundNative === 1
          ? `  The AI package meets minimum trust level ${minTrust}.`
          : `  All ${foundNative} AI packages meet minimum trust level ${minTrust}.`
      )
    );
  }

  // Out of scope: libraries. Compact list + HMA CTA — these aren't audited
  // by ai-trust, they're routed to HackMyAgent for general security scanning.
  if (unrelated.length > 0) {
    lines.push(divider("Out of scope (libraries)"));
    lines.push(
      chalk.dim(
        `  ai-trust is for AI packages. For general security, use HackMyAgent.`
      )
    );
    lines.push(outOfScopeNamesLine(unrelated));
    lines.push(...notFoundLibrariesLines(unrelated));
  }

  // Unknown: packages we couldn't classify. Surface clearly.
  if (unknown.length > 0) {
    lines.push(...unclassifiedSectionLines(unknown));
  }

  lines.push(...typeMismatchSectionLines(excluded, opts.type));

  // Trust level legend (only meaningful if there are native packages)
  const hasNonVerified = native.some(
    (r) => r.found && r.trustLevel < 4
  );
  if (hasNonVerified) {
    lines.push("");
    lines.push(`  ${trustLevelLegend(minTrust)}`);
  }

  // Next steps. Each names the packages it is for and the file `audit`
  // read; `<file>` stays only in `batch`, which reads no file. After
  // `audit` scanned the missing packages, it does not offer that scan again.
  const names = (rs: TrustAnswer[]): string[] => rs.map((r) => r.name);
  const steps: string[] = [];
  if (errorScans.length > 0) {
    steps.push(...checkCommandSteps("Rescan errors:", names(errorScans), ecosystem));
  }
  if (notFound.length > 0) {
    if (opts.scannedMissing !== true) {
      const file = opts.file !== undefined ? shellArg(stripControlCharacters(opts.file)) : "<file>";
      steps.push(commandStep("Scan missing:", `ai-trust audit ${file} --scan-missing`));
    }
    steps.push(...checkCommandSteps("Check individual:", names(notFound), ecosystem));
  }
  if (belowThreshold.length > 0) {
    steps.push(...checkCommandSteps("Inspect flagged:", names(belowThreshold), ecosystem));
  }
  if (unknown.length > 0) {
    steps.push(...checkCommandSteps("Classify unknown:", names(unknown), ecosystem));
  }
  for (const command of mismatchCommands) {
    steps.push(`  ${chalk.cyan("Look up by type:")}   ${command}`);
  }
  // The library step is for the libraries listed above.
  if (unrelated.length > 0) {
    steps.push(commandStep("Library security:", "npx hackmyagent secure ."));
  }
  // A run with nothing left to do has no Next Steps section.
  if (steps.length > 0) {
    lines.push(divider("Next Steps"));
    lines.push(...steps);
  }

  lines.push("");
  return lines.join("\n");
}

export interface FormatScanResultOptions {
  /**
   * True when the scanned artifact is a downloaded third-party package
   * (the default `check <pkg>` npm pack / PyPI archive path) rather than the
   * user's own working tree (`--scan-path`). Threaded into the cli-ui
   * SurfaceSummary so the verdict guidance is review / choose-a-vetted-version
   * instead of `secure --fix` on code the user does not own. Defaults to
   * local (false).
   */
  remote?: boolean;
  /**
   * The ecosystem the package was downloaded from. A `pip:<name>` target
   * names it in the header (`six (pypi)  downloaded package`), as the
   * registry answer's header does. Defaults to npm, which adds nothing.
   */
  ecosystem?: "npm" | "pypi";
  /**
   * The directory `check --scan-path` scanned, as the user gave it. Named in
   * the notice for a scan that read 0 files, with a command that lists it,
   * and in the Verify command of each finding with a file and a line.
   */
  scanPath?: string;
  /**
   * The `file` values of findings that name nothing in `scanPath`, as
   * check.ts found them. Such a finding names the file its fix would create:
   * its location is marked "(not present)" and it gets no Verify command.
   */
  absentFiles?: ReadonlySet<string>;
  /**
   * Print every failed finding (`check --all`). Without it the first ten are
   * printed, by severity, and a line counts the rest.
   */
  all?: boolean;
  /**
   * The command that printed this result, without `--all`. The line that
   * counts the findings not printed cites it with `--all` appended. Defaults
   * to `<check citation> <packageName>`.
   */
  rerunCommand?: string;
  /**
   * The registry's answer for the package, when the same run looked it up
   * before scanning. A registry score more than REGISTRY_GAP_POINTS from this
   * scan's score is printed beside it, with both dates.
   */
  registry?: TrustAnswer;
}

/** Findings printed in text mode when `--all` is not given. */
const FINDINGS_SHOWN_BY_DEFAULT = 10;

/** The most check ids the not-counted line names before it counts the rest. */
const MAX_NOT_COUNTED_SHOWN = 5;

/**
 * "Not counted: GIT-001, DEP-001, SANDBOX-001 (...)" for a downloaded
 * package whose scan left failed local-setup checks out of its score, or
 * null when it left none out.
 */
function notCountedLine(result: ScanResult): string | null {
  const ids = result.notCounted ?? [];
  if (ids.length === 0) return null;
  const shown = ids.slice(0, MAX_NOT_COUNTED_SHOWN).map((id) => stripControlCharacters(id));
  const more = ids.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
  return `Not counted: ${list} (local-setup checks a downloaded package is not scored on; --scan-path counts them)`;
}

export function formatScanResult(result: ScanResult, opts: FormatScanResultOptions = {}): string {
  const remote = opts.remote === true;
  const vc = verdictColor(result.verdict);
  const scoreVal = Math.round(result.trustScore * 100);

  const lines: string[] = [
    "",
    `  ${chalk.bold.white(result.packageName)}${resolvedVersionSuffix(result)}${ecosystemSuffix(opts.ecosystem ?? "npm")}  ${chalk.dim(remote ? "downloaded package" : "local scan")}`,
  ];

  // The scanner read no file and found none it could not read. The checks
  // that still ran report files that are absent (no lock file, no
  // .gitignore), so the score, the level, the verdict and those findings
  // would describe a measurement that did not happen. Say there was nothing
  // to scan and print none of them. A directory whose files were found but
  // could not be read keeps its score and findings: they name those files.
  if (nothingToScan(result.scan)) {
    const target = stripControlCharacters(opts.scanPath ?? result.packageName);
    lines.push(`  ${chalk.bold(`Nothing to scan in ${target}: 0 files read.`)}`);
    if (opts.scanPath !== undefined) {
      lines.push("");
      lines.push(`  ${chalk.cyan("Verify:")}  ls -A ${shellArg(target)}`);
      lines.push(`  ${chalk.cyan("Fix:")}     pass --scan-path a directory that holds the files to scan`);
    }
    lines.push("");
    return lines.join("\n");
  }

  // Verdict
  const failed = result.scan.findings.filter((f) => !f.passed);
  const critical = failed.filter((f) => f.severity === "critical").length;
  const high = failed.filter((f) => f.severity === "high").length;
  const medium = failed.filter((f) => f.severity === "medium").length;
  const low = failed.filter((f) => f.severity === "low").length;
  const total = failed.length;

  // How much was actually measured. `checksEvaluated` counts executed static
  // checks (passed + failed); when it is explicitly 0 — and nothing semantic
  // ran either — the package had no analyzable surfaces, so a 100/100 here
  // would be a "number implies measurement" artifact, not an earned score.
  const noAnalyzableSurfaces = hasNoAnalyzableSurfaces(result);

  // Single source of truth for ai-trust's human verdict: derive BOTH the top
  // headline and the Observations-block message from the score-aware enum
  // (result.verdict from deriveVerdict), so the terminal never contradicts
  // `--json`. cli-ui's severity-first buildVerdict stays for HMA/opena2a
  // own-code scans — verdict calibration is intentionally context-specific
  // (own-code vs third-party). See score-aware-verdict.ts.
  const absentFiles = opts.absentFiles ?? new Set<string>();
  const verdictFindings: LeadFinding[] = failed.map((f) => ({
    severity: f.severity as "critical" | "high" | "medium" | "low",
    name: f.name,
    checkId: f.checkId,
    file: typeof f.file === "string" ? stripControlCharacters(f.file) : undefined,
    line: f.line,
    absent: typeof f.file === "string" && absentFiles.has(f.file),
  }));
  const rawKind = result.scan.projectType?.trim();
  const projectLabel = rawKind && rawKind !== "unknown" ? rawKind : "package";
  const scoreAwareVerdict = noAnalyzableSurfaces
    ? null
    : buildScoreAwareVerdict(
        result.verdict,
        { critical, high, medium, low, total },
        verdictFindings,
        { kind: projectLabel, remote },
      );
  const verdictText = scoreAwareVerdict
    ? scoreAwareVerdict.headline
    : "No analyzable surfaces — not scored";
  lines.push(`  ${chalk.bold(vc(verdictText))}`);

  // Score meter — show Security (from local scan), not Trust (that's registry).
  // Suppress the meter entirely when nothing was analyzable: a score from 0
  // executed checks is meaningless and reads as a clean bill of health.
  lines.push("");
  if (noAnalyzableSurfaces) {
    lines.push(
      `  Security  ${chalk.dim("not scored — no analyzable surfaces (use `npx hackmyagent check` for a deeper scan)")}`,
    );
  } else {
    lines.push(`  Security  ${scoreMeter(result.scan.score, result.scan.maxScore)}`);
    // A downloaded package's score leaves out the checks that describe a
    // local setup; say which failed, since `--scan-path` on the same files
    // counts them.
    const notCounted = notCountedLine(result);
    if (notCounted) lines.push(`            ${chalk.dim(notCounted)}`);
  }

  // Trust level
  const tlColor = trustLevelColor(result.trustLevel);
  lines.push(
    `  Level     ${chalk.bold(tlColor(trustLevelLabel(result.trustLevel)))} ${chalk.dim(`(${result.trustLevel}/4)`)}`
  );
  const gap = opts.registry ? registryGapLine(opts.registry, result) : null;
  if (gap) lines.push(`  ${chalk.yellow(gap)}`);

  // ── Observations + Verdict ──────────────────────────────────────────
  // Shared block from @opena2a/cli-ui so ai-trust's local-
  // scan output stays consistent with hackmyagent secure + opena2a review.
  // Only wired on formatScanResult (real findings). formatCheckResult is
  // registry-lookup metadata with no findings to categorize — left for a
  // future translation layer per brief §7.
  const categorizable: CategorizableFinding[] = failed.map((f) => ({
    checkId: f.checkId,
    name: f.name,
    category: f.category,
    passed: false,
    severity: f.severity as "critical" | "high" | "medium" | "low",
  }));
  const categorySummaries = buildCategorySummaries(categorizable);
  // Same score-aware verdict computed above feeds the Observations block, so
  // the block message and the top headline always agree. When nothing was
  // analyzable, override to "unknown" (a vacuous 0-check scan must not read as
  // "looks safe to use").
  const verdict = scoreAwareVerdict
    ? { status: scoreAwareVerdict.status, message: scoreAwareVerdict.message }
    : {
        status: "unknown" as const,
        message:
          "No analyzable surfaces — not scored. Use `npx hackmyagent check` for a deeper scan.",
      };
  // The scanner's semantic count is its compile count. A --no-deep scan did
  // not run that layer and an older scanner does not report it; neither is a
  // measured 0, so the Checks line names which one it is.
  const scannerSemanticCount = result.scan.semanticCount;
  const semanticNote = result.scan.staticOnly
    ? "0 semantic (not run: --no-deep)"
    : scannerSemanticCount === undefined
      ? "semantic not reported"
      : null;
  const { lines: renderedObsLines } = renderObservationsBlock({
    surfaces: { kind: projectLabel, remote },
    checks: {
      // Executed static checks (passed + failed), not just failures, and not
      // the semantic layer's AST-*/SEM-* records. Falls back to the
      // executed-records and then the findings count for older HMA output.
      staticCount:
        result.scan.staticChecksEvaluated ??
        result.scan.checksEvaluated ??
        result.scan.findings.length,
      semanticCount: scannerSemanticCount ?? 0,
    },
    categories: categorySummaries,
    verdict,
  });
  const obsLines =
    semanticNote === null
      ? renderedObsLines
      : renderedObsLines.map((obs) =>
          obs.label === "Checks"
            ? { ...obs, value: obs.value.replace("0 semantic (NanoMind AST)", semanticNote) }
            : obs,
        );
  lines.push("");
  lines.push(divider("Observations"));
  const tonePaint = (
    tone: "default" | "good" | "warning" | "critical",
    s: string,
  ): string => {
    if (tone === "good") return chalk.green(s);
    if (tone === "warning") return chalk.yellow(s);
    if (tone === "critical") return chalk.red(s);
    return s;
  };
  const OBS_LABEL_WIDTH = 12;
  for (const obs of obsLines) {
    const labelPad = obs.label.padEnd(OBS_LABEL_WIDTH, " ");
    lines.push(`  ${chalk.dim(labelPad)}${tonePaint(obs.tone, obs.value)}`);
  }

  // Findings
  if (total > 0) {
    const summaryParts: string[] = [];
    if (critical > 0) summaryParts.push(chalk.red.bold(`${critical} critical`));
    if (high > 0) summaryParts.push(chalk.yellow.bold(`${high} high`));
    if (medium > 0) summaryParts.push(chalk.yellow(`${medium} medium`));
    if (low > 0) summaryParts.push(chalk.dim(`${low} low`));

    lines.push(divider("Findings"));
    lines.push(`  ${summaryParts.join("  ")}`);

    // Sort by severity
    const sevWeight: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };
    failed.sort(
      (a, b) => (sevWeight[b.severity] || 0) - (sevWeight[a.severity] || 0)
    );

    // Show the top findings (every one with --all) with colored borders
    const limit = opts.all
      ? failed.length
      : Math.min(failed.length, FINDINGS_SHOWN_BY_DEFAULT);
    for (let i = 0; i < limit; i++) {
      const f = failed[i];
      const sevColor =
        f.severity === "critical"
          ? chalk.red
          : f.severity === "high"
            ? chalk.yellow
            : chalk.gray;
      const label = f.severity.toUpperCase();

      lines.push("");
      lines.push(
        `  ${sevColor("\u2502")} ${sevColor.bold(label)}  ${chalk.bold.white(f.name)}`
      );
      // The path comes from the scanned tree, so control characters in it
      // are removed before it reaches the terminal. A file the scanned
      // directory does not have is the one the fix would create.
      if (typeof f.file === "string" && f.file !== "") {
        const loc = stripControlCharacters(f.file) + (typeof f.line === "number" ? `:${f.line}` : "");
        const shown = absentFiles.has(f.file) ? `${loc} (not present)` : loc;
        lines.push(`  ${sevColor("\u2502")} ${chalk.dim(shown)}`);
      }
      if (f.message && f.message !== f.name) {
        lines.push(`  ${sevColor("\u2502")} ${f.message}`);
      }
      // Only a scanned directory is still on disk to verify against, and
      // only a reader's own tree is theirs to fix.
      if (opts.scanPath !== undefined) {
        const verify = verifyCommand(opts.scanPath, f, absentFiles);
        if (verify) lines.push(`  ${sevColor("\u2502")} ${chalk.cyan("Verify:")} ${verify}`);
      }
      if (f.fix) {
        lines.push(`  ${sevColor("\u2502")} ${chalk.cyan("Fix:")} ${runnableFix(f.fix)}`);
      } else if (opts.scanPath !== undefined) {
        lines.push(`  ${sevColor("\u2502")} ${chalk.cyan("Fix:")} ${noFixSupplied(f.checkId)}`);
      }
      if (f.attackClass) {
        lines.push(
          `  ${sevColor("\u2502")} ${chalk.dim("Attack:")} ${chalk.cyan(f.attackClass)}`
        );
      }
    }

    if (failed.length > limit) {
      const rerun =
        opts.rerunCommand ?? `${checkCitation()} ${shellArg(result.packageName)}`;
      lines.push(
        `\n  ${chalk.dim(`+ ${failed.length - limit} more findings (show all: ${rerun} --all)`)}`
      );
    }

    // Path forward
    if (critical > 0 || high > 0) {
      const recoveryParts: string[] = [];
      if (critical > 0) recoveryParts.push(`${critical} critical`);
      if (high > 0) recoveryParts.push(`${high} high`);
      const estRecovery = Math.min(
        100,
        result.scan.score + critical * 15 + high * 8
      );
      lines.push("");
      lines.push(
        `  ${chalk.cyan.bold("Path forward:")} ${chalk.cyan(String(result.scan.score))} ${chalk.dim("->")} ${chalk.green.bold(String(estRecovery))} ${chalk.cyan(`by fixing ${recoveryParts.join(" + ")}`)}`
      );
    }
  } else {
    lines.push("");
    lines.push(chalk.green("  No security findings."));
  }

  // NanoMind semantic analysis
  if (result.semanticFindings && result.semanticFindings.length > 0) {
    lines.push(divider("Semantic Analysis"));

    for (const sf of result.semanticFindings) {
      const confidencePct = Math.round(sf.confidence * 100);
      const confidenceColor =
        sf.confidence >= 0.8
          ? chalk.red
          : sf.confidence >= 0.5
            ? chalk.yellow
            : chalk.gray;

      lines.push(
        `  ${chalk.magenta("\u2502")} ${chalk.magenta.bold(sf.intentClass)}  ${sf.attackClass}` +
          `  ${confidenceColor(`${confidencePct}%`)}` +
          (sf.file ? chalk.dim(`  ${sf.file}`) : "")
      );
    }
  }

  // AI analyst findings (from --analyze mode)
  if (result.analystFindings && result.analystFindings.length > 0) {
    lines.push(divider("AnaLM Analysis"));

    for (const af of result.analystFindings) {
      const r = af.result;
      if (af.taskType === "threatAnalysis") {
        const level = String(r.threatLevel ?? "unknown").toUpperCase();
        const levelColor =
          level === "CRITICAL" || level === "HIGH"
            ? chalk.red
            : level === "MEDIUM"
              ? chalk.yellow
              : chalk.dim;
        lines.push(
          `  ${chalk.cyan("\u2502")} ${levelColor.bold(level)}  ${r.attackVector ?? ""}`
        );
        if (r.description) {
          lines.push(`  ${chalk.cyan("\u2502")} ${r.description}`);
        }
        if (Array.isArray(r.mitigations)) {
          for (const m of r.mitigations) {
            lines.push(`  ${chalk.cyan("\u2502")} ${chalk.cyan("Fix:")} ${m}`);
          }
        }
      } else if (af.taskType === "credentialContextClassification") {
        const cls = String(r.classification ?? "unknown");
        const clsColor =
          cls === "real"
            ? chalk.red
            : cls === "test" || cls === "example"
              ? chalk.green
              : chalk.yellow;
        lines.push(
          `  ${chalk.cyan("\u2502")} Credential: ${clsColor.bold(cls)}`
        );
        if (r.reasoning) {
          lines.push(`  ${chalk.cyan("\u2502")} ${r.reasoning}`);
        }
      }
      lines.push(
        `  ${chalk.cyan("\u2502")} ${chalk.dim(`${Math.round(af.confidence * 100)}% confidence | ${af.modelVersion}`)}`
      );
      lines.push("");
    }
  }

  // Trust level legend
  if (result.trustLevel < 4) {
    lines.push("");
    lines.push(`  ${trustLevelLegend(result.trustLevel)}`);
  }

  // Next steps
  const nextSteps: string[] = [];
  if (result.verdict === "warning" || result.verdict === "blocked") {
    nextSteps.push(
      `  ${chalk.cyan("Remediate:")}         Review findings above before installing`
    );
  }
  if (critical > 0 || high > 0) {
    // For a downloaded third-party package the findings live in code the user
    // does not own, so `secure --fix` is the wrong action — the action is to
    // pin a vetted version or pick an alternative. Keep `secure --fix` only
    // for local scans (the user's own tree). Stays consistent with the
    // cli-ui remote-aware Verdict line above.
    nextSteps.push(
      remote
        ? `  ${chalk.cyan("Next:")}              Pin a vetted version or choose an alternative — these findings are in the package's own code`
        : `  ${chalk.cyan("Auto-fix:")}          npx hackmyagent secure --fix`
    );
  }
  const audit = auditCta();
  if (audit) {
    nextSteps.push(`  ${chalk.cyan(`${audit.label}:`)} ${audit.command}`);
  }
  // A clean scan in a directory with no dependency file has no next step;
  // the section is left out rather than printed empty.
  if (nextSteps.length > 0) {
    lines.push(divider("Next Steps"));
    lines.push(...nextSteps);
  }

  lines.push("");
  return lines.join("\n");
}

export function formatJson(data: unknown): string {
  // JSON.stringify escapes the C0 controls. DEL and the C1 controls come out
  // raw, so they are written as \u00XX escapes, which parse back to the same
  // string. They occur only inside JSON strings.
  return JSON.stringify(data, null, 2).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
