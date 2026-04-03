/**
 * Output formatting for trust query results.
 * Supports colored terminal output and raw JSON.
 */

import chalk from "chalk";
import type { TrustAnswer, BatchResponse } from "../api/client.js";
import type { ScanResult } from "../scanner/index.js";

/**
 * Normalize registry verdicts to the CLI's display vocabulary.
 * Registry may return "listed", "passed", "warnings", etc.
 */
function normalizeVerdict(verdict: string): string {
  switch (verdict) {
    case "safe":
    case "passed":
      return "safe";
    case "warning":
    case "warnings":
      return "warning";
    case "blocked":
    case "failed":
      return "blocked";
    case "listed":
      return "listed";
    default:
      return verdict;
  }
}

function verdictColor(verdict: string): (text: string) => string {
  const normalized = normalizeVerdict(verdict);
  switch (normalized) {
    case "safe":
      return chalk.green;
    case "warning":
      return chalk.yellow;
    case "blocked":
      return chalk.red;
    case "listed":
      return chalk.cyan;
    default:
      return chalk.gray;
  }
}

function trustLevelLabel(level: number): string {
  switch (level) {
    case 0:
      return "Blocked";
    case 1:
      return "Warning";
    case 2:
      return "Listed";
    case 3:
      return "Scanned";
    case 4:
      return "Verified";
    default:
      return `Unknown (${level})`;
  }
}

function trustLevelColor(level: number): (text: string) => string {
  if (level >= 3) return chalk.green;
  if (level >= 1) return chalk.yellow;
  return chalk.red;
}

/**
 * Format trust score for display. Shows "Not scanned" when there's no real data
 * instead of a misleading "0/100".
 */
function formatScore(trustScore: number, scanStatus?: string): string {
  // Show "Not scanned" when there's no actual scan data.
  // A non-zero score from metadata alone is misleading (8/100 for
  // the Anthropic SDK looks dangerous when it just means "not scanned yet").
  const notScanned = !scanStatus ||
    scanStatus === "" ||
    scanStatus === "pending" ||
    scanStatus === "not_applicable";
  if (notScanned && !hasPassedScan(scanStatus)) {
    return "Not scanned";
  }
  return `${Math.round(trustScore * 100)}/100`;
}

function hasPassedScan(scanStatus?: string): boolean {
  return scanStatus === "passed" || scanStatus === "warnings";
}

/**
 * Format confidence level for display.
 */
function formatConfidence(confidence?: number): string | null {
  if (confidence === undefined || confidence === null || confidence === 0) {
    return null;
  }
  if (confidence >= 0.7) return "high confidence";
  if (confidence >= 0.4) return "moderate confidence";
  return "low confidence";
}

/**
 * Format scan age for display.
 */
function formatScanAge(lastScannedAt?: string): string | null {
  if (!lastScannedAt) return null;
  const scanned = new Date(lastScannedAt);
  const now = new Date();
  const days = Math.floor((now.getTime() - scanned.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days > 90) return `${days} days ago (stale)`;
  return `${days} days ago`;
}

const TRUST_LEVEL_LEGEND =
  "  Trust levels: Blocked (0) < Warning (1) < Listed (2) < Scanned (3) < Verified (4)";

export function formatCheckResult(answer: TrustAnswer): string {
  if (!answer.found) {
    return [
      chalk.bold(`  ${answer.name}`),
      chalk.gray(`  Type: ${answer.packageType || "unknown"}`),
      chalk.gray("  Status: Not found in registry"),
      "",
    ].join("\n");
  }

  const normalized = normalizeVerdict(answer.verdict);
  const colorVerdict = verdictColor(answer.verdict);
  const colorTrust = trustLevelColor(answer.trustLevel);
  const scoreDisplay = formatScore(answer.trustScore, answer.scanStatus);
  const isUnscanned = scoreDisplay === "Not scanned";

  const lines: string[] = [
    chalk.bold(`  ${answer.name}`),
    `  Type:           ${answer.packageType || "unknown"}`,
    `  Verdict:        ${colorVerdict(normalized.toUpperCase())}`,
    `  Trust Level:    ${colorTrust(trustLevelLabel(answer.trustLevel))} (${answer.trustLevel}/4)`,
    `  Trust Score:    ${isUnscanned ? chalk.gray(scoreDisplay) : scoreDisplay}`,
  ];

  // Show confidence if available
  const confidence = formatConfidence(answer.confidence);
  if (confidence) {
    lines.push(`  Confidence:     ${confidence}`);
  }

  // Show scan age
  const scanAge = formatScanAge(answer.lastScannedAt);
  if (scanAge) {
    lines.push(`  Last Scanned:   ${scanAge.includes("stale") ? chalk.yellow(scanAge) : scanAge}`);
  } else if (!isUnscanned) {
    lines.push(`  Scan Status:    ${answer.scanStatus || "unknown"}`);
  }

  // Disclaimer for unscanned packages
  if (isUnscanned) {
    lines.push("");
    lines.push(chalk.yellow("  This package has not been security-scanned."));
    lines.push(chalk.yellow("  Trust level reflects registry listing only."));
  }

  if (answer.dependencies && answer.dependencies.totalDeps > 0) {
    const deps = answer.dependencies;
    lines.push("");
    lines.push(chalk.bold("  Dependencies"));
    lines.push(`  Total:          ${deps.totalDeps}`);
    lines.push(`  Vulnerable:     ${deps.vulnerableDeps > 0 ? chalk.red(String(deps.vulnerableDeps)) : chalk.green("0")}`);
    lines.push(`  Min Trust:      ${deps.minTrustLevel}/4`);
  }

  // Trust level legend (only when not already at the highest level)
  if (answer.trustLevel < 4) {
    lines.push(chalk.gray(TRUST_LEVEL_LEGEND));
    lines.push("");
  }

  // Contextual next steps
  const nextSteps: string[] = [];
  if (normalized === "blocked" || normalized === "warning") {
    nextSteps.push(
      `  Run a local security scan: ai-trust check ${answer.name} --scan-if-missing`
    );
  } else if (answer.trustLevel <= 2) {
    nextSteps.push(
      `  Trust data is limited. Run a local scan to improve: ai-trust check ${answer.name} --scan-if-missing`
    );
  }
  nextSteps.push(
    "  For a full project audit: ai-trust audit package.json"
  );

  lines.push(chalk.bold("  Next steps"));
  for (const step of nextSteps) {
    lines.push(chalk.gray(step));
  }

  lines.push("");
  return lines.join("\n");
}

export function formatBatchResults(
  response: BatchResponse,
  minTrust: number
): string {
  const lines: string[] = [];

  lines.push(
    chalk.bold(
      `  Trust Audit: ${response.meta.total} packages queried, ${response.meta.found} found, ${response.meta.notFound} not found`
    )
  );
  lines.push("");

  // Table header
  const nameWidth = 40;
  const typeWidth = 14;
  const verdictWidth = 10;
  const levelWidth = 12;
  const scoreWidth = 14;
  const scanWidth = 10;

  lines.push(
    "  " +
      "PACKAGE".padEnd(nameWidth) +
      "TYPE".padEnd(typeWidth) +
      "VERDICT".padEnd(verdictWidth) +
      "TRUST".padEnd(levelWidth) +
      "SCORE".padEnd(scoreWidth) +
      "SCAN".padEnd(scanWidth)
  );
  lines.push("  " + "-".repeat(nameWidth + typeWidth + verdictWidth + levelWidth + scoreWidth + scanWidth));

  for (const result of response.results) {
    const name = result.name.length > nameWidth - 2
      ? result.name.substring(0, nameWidth - 5) + "..."
      : result.name;

    if (!result.found) {
      // Not-found packages: show "NO DATA" instead of misleading "UNKNOWN/Blocked"
      lines.push(
        "  " +
          name.padEnd(nameWidth) +
          "-".padEnd(typeWidth) +
          chalk.gray("NO DATA".padEnd(verdictWidth)) +
          chalk.gray("-".padEnd(levelWidth)) +
          "-".padEnd(scoreWidth) +
          "-".padEnd(scanWidth)
      );
      continue;
    }

    const normalized = normalizeVerdict(result.verdict);
    const colorVerdict = verdictColor(result.verdict);
    const colorTrust = trustLevelColor(result.trustLevel);
    const scoreDisplay = formatScore(result.trustScore, result.scanStatus);

    lines.push(
      "  " +
        name.padEnd(nameWidth) +
        (result.packageType || "-").padEnd(typeWidth) +
        colorVerdict(normalized.toUpperCase().padEnd(verdictWidth)) +
        colorTrust(trustLevelLabel(result.trustLevel).padEnd(levelWidth)) +
        scoreDisplay.padEnd(scoreWidth) +
        (result.scanStatus || "-").padEnd(scanWidth)
    );
  }

  // Summary
  const belowThreshold = response.results.filter(
    (r) => r.found && r.trustLevel < minTrust
  );
  const notFound = response.results.filter((r) => !r.found);

  lines.push("");

  if (belowThreshold.length > 0) {
    lines.push(
      chalk.yellow(
        `  [!] ${belowThreshold.length} package(s) below minimum trust level ${minTrust}:`
      )
    );
    for (const pkg of belowThreshold) {
      lines.push(
        chalk.yellow(
          `      - ${pkg.name} (trust level ${pkg.trustLevel}, verdict: ${pkg.verdict})`
        )
      );
    }
  }

  if (notFound.length > 0) {
    lines.push(
      chalk.yellow(
        `  [?] ${notFound.length} package(s) not found in registry (no trust data):`
      )
    );
    for (const pkg of notFound) {
      lines.push(chalk.yellow(`      - ${pkg.name}`));
    }
  }

  if (belowThreshold.length === 0 && notFound.length === 0) {
    lines.push(
      chalk.green(
        `  All ${response.meta.found} packages meet minimum trust level ${minTrust}.`
      )
    );
  }

  // Trust level legend (show if any package is below Verified)
  const hasNonVerified = response.results.some(
    (r) => r.found && r.trustLevel < 4
  );
  if (hasNonVerified) {
    lines.push("");
    lines.push(chalk.gray(TRUST_LEVEL_LEGEND));
  }

  // Contextual next steps
  lines.push("");
  lines.push(chalk.bold("  Next steps"));
  if (notFound.length > 0) {
    lines.push(
      chalk.gray(
        "  Scan unknown packages locally: ai-trust audit <file> --scan-missing"
      )
    );
    lines.push(
      chalk.gray(
        "  Or check individually: ai-trust check <name> --scan-if-missing"
      )
    );
  }
  if (belowThreshold.length > 0) {
    lines.push(
      chalk.gray(
        "  Inspect flagged packages: ai-trust check <name>"
      )
    );
  }
  lines.push(
    chalk.gray("  Full project security scan: npx hackmyagent secure .")
  );

  lines.push("");
  return lines.join("\n");
}

export function formatScanResult(result: ScanResult): string {
  const colorVerdict = verdictColor(result.verdict);
  const colorTrust = trustLevelColor(result.trustLevel);

  const lines: string[] = [
    chalk.bold(`  ${result.packageName}`) +
      chalk.gray("  (local scan)"),
    `  Verdict:        ${colorVerdict(result.verdict.toUpperCase())}`,
    `  Trust Level:    ${colorTrust(trustLevelLabel(result.trustLevel))} (${result.trustLevel}/4)`,
    `  Trust Score:    ${Math.round(result.trustScore * 100)}/100`,
    `  HMA Score:      ${result.scan.score}/${result.scan.maxScore}`,
  ];

  const failed = result.scan.findings.filter((f) => !f.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Findings"));

    const bySeverity = {
      critical: failed.filter((f) => f.severity === "critical"),
      high: failed.filter((f) => f.severity === "high"),
      medium: failed.filter((f) => f.severity === "medium"),
      low: failed.filter((f) => f.severity === "low"),
    };

    for (const [sev, items] of Object.entries(bySeverity)) {
      if (items.length === 0) continue;
      const colorFn =
        sev === "critical"
          ? chalk.red
          : sev === "high"
            ? chalk.yellow
            : chalk.gray;
      for (const item of items) {
        lines.push(
          `  ${colorFn(`[${sev.toUpperCase()}]`)} ${item.name}: ${item.message}`
        );
        if (item.attackClass) {
          lines.push(
            `  ${' '.repeat(sev.length + 3)}${chalk.dim('Attack Class:')} ${chalk.cyan(item.attackClass)}`
          );
        }
      }
    }
  } else {
    lines.push("");
    lines.push(chalk.green("  No security findings."));
  }

  // NanoMind semantic analysis section
  if (result.semanticFindings && result.semanticFindings.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Semantic Analysis (NanoMind)"));

    for (const sf of result.semanticFindings) {
      const confidencePct = Math.round(sf.confidence * 100);
      const confidenceColor =
        sf.confidence >= 0.8
          ? chalk.red
          : sf.confidence >= 0.5
            ? chalk.yellow
            : chalk.gray;

      lines.push(
        `  ${chalk.magenta(`[${sf.intentClass}]`)} ${sf.attackClass}` +
          `  ${confidenceColor(`${confidencePct}% confidence`)}` +
          (sf.file ? chalk.gray(`  ${sf.file}`) : "")
      );
    }
  }

  // Trust level legend (only when not already at the highest level)
  if (result.trustLevel < 4) {
    lines.push("");
    lines.push(chalk.gray(TRUST_LEVEL_LEGEND));
  }

  // Contextual next steps
  lines.push("");
  lines.push(chalk.bold("  Next steps"));
  if (result.verdict === "warning" || result.verdict === "blocked") {
    lines.push(
      chalk.gray(
        `  Review findings above and remediate before installing`
      )
    );
  }
  lines.push(
    chalk.gray(
      "  For a full project audit: ai-trust audit package.json"
    )
  );

  lines.push("");
  return lines.join("\n");
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
