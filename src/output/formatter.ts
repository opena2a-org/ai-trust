/**
 * Output formatting for trust query results.
 * Visual design aligned with hackmyagent CLI:
 *   - Score meter with colored bar
 *   - Section dividers
 *   - Severity-colored finding borders
 *   - Actionable next steps
 */

import chalk from "chalk";
import type { TrustAnswer, BatchResponse } from "../api/client.js";
import type { ScanResult } from "../scanner/index.js";

// ── Visual helpers ─────────────────────────────────────────────���──────

const METER_WIDTH = 20;

function scoreMeter(value: number, max: number = 100): string {
  const pct = Math.round((value / max) * METER_WIDTH);
  const meterColor = value >= 70 ? chalk.green : value >= 40 ? chalk.yellow : chalk.red;
  const filled = "\u2501".repeat(pct);
  const empty = "\u2501".repeat(METER_WIDTH - pct);
  return `${meterColor(filled)}${chalk.dim(empty)} ${meterColor.bold(String(value))}${chalk.dim(`/${max}`)}`;
}

function divider(label?: string): string {
  if (label) {
    const pad = Math.max(1, 56 - label.length);
    return `\n  ${chalk.dim("\u2500\u2500")} ${chalk.bold(label)} ${chalk.dim("\u2500".repeat(pad))}`;
  }
  return `  ${chalk.dim("\u2500".repeat(62))}`;
}

function trustLevelLegend(currentLevel: number): string {
  const levels = ["Blocked", "Warning", "Listed", "Scanned", "Verified"];
  return levels
    .map((l, i) => {
      if (i === currentLevel) return trustLevelColor(i).bold(l);
      return chalk.dim(l);
    })
    .join(chalk.dim(" > "));
}

// ── Data helpers ──────────────────────────────────────────────────────

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

function trustLevelColor(level: number) {
  if (level >= 3) return chalk.green;
  if (level >= 1) return chalk.yellow;
  return chalk.red;
}

function formatScore(trustScore: number, scanStatus?: string): string {
  const notScanned =
    !scanStatus ||
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

function formatScanAge(lastScannedAt?: string): string | null {
  if (!lastScannedAt) return null;
  const scanned = new Date(lastScannedAt);
  const now = new Date();
  const days = Math.floor(
    (now.getTime() - scanned.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days > 90) return `${days} days ago (stale)`;
  return `${days} days ago`;
}

// ── Formatters ────────────────────────────────────────────────────────

export function formatCheckResult(answer: TrustAnswer): string {
  if (!answer.found) {
    return [
      "",
      `  ${chalk.bold(answer.name)}  ${chalk.dim(answer.packageType || "unknown")}`,
      `  ${chalk.yellow.bold("Not found in registry")}`,
      "",
      divider("Next Steps"),
      `  ${chalk.cyan("Scan locally:")}       ai-trust check ${answer.name} --scan-if-missing`,
      `  ${chalk.cyan("Full project audit:")} ai-trust audit package.json`,
      "",
    ].join("\n");
  }

  const normalized = normalizeVerdict(answer.verdict);
  const scoreDisplay = formatScore(answer.trustScore, answer.scanStatus);
  const isUnscanned = scoreDisplay === "Not scanned";
  const scoreVal = Math.round(answer.trustScore * 100);

  // Header
  const meta: string[] = [answer.packageType || "unknown"];
  const scanAge = formatScanAge(answer.lastScannedAt);
  if (scanAge) meta.push(`scanned ${scanAge}`);

  const lines: string[] = [
    "",
    `  ${chalk.bold.white(answer.name)}  ${chalk.dim(meta.join(" \u00b7 "))}`,
  ];

  // Verdict
  let verdictText: string;
  const vc = verdictColor(answer.verdict);
  if (normalized === "blocked") {
    verdictText = "Blocked by registry";
  } else if (normalized === "warning") {
    verdictText = "Review before installing";
  } else if (isUnscanned) {
    verdictText = "Not yet security-scanned";
  } else {
    verdictText = "No known issues";
  }
  lines.push(`  ${chalk.bold(vc(verdictText))}`);

  // Score meter
  lines.push("");
  if (isUnscanned) {
    lines.push(`  Trust     ${chalk.dim("not scanned \u2014 trust level reflects registry listing only")}`);
  } else {
    lines.push(`  Trust     ${scoreMeter(scoreVal)}`);
  }

  // Trust level
  const tlColor = trustLevelColor(answer.trustLevel);
  lines.push(
    `  Level     ${chalk.bold(tlColor(trustLevelLabel(answer.trustLevel)))} ${chalk.dim(`(${answer.trustLevel}/4)`)}`
  );

  // Dependencies
  if (answer.dependencies && answer.dependencies.totalDeps > 0) {
    const deps = answer.dependencies;
    const depParts: string[] = [`${deps.totalDeps} total`];
    if (deps.vulnerableDeps > 0)
      depParts.push(chalk.red(`${deps.vulnerableDeps} vulnerable`));
    if (deps.minTrustLevel !== undefined)
      depParts.push(`min trust ${deps.minTrustLevel}/4`);
    lines.push(`  Deps      ${depParts.join(chalk.dim(" \u00b7 "))}`);
  }

  // Trust level legend
  if (answer.trustLevel < 4) {
    lines.push(`  ${trustLevelLegend(answer.trustLevel)}`);
  }

  // Next steps
  lines.push(divider("Next Steps"));
  if (isUnscanned || answer.trustLevel <= 2) {
    lines.push(
      `  ${chalk.cyan("Scan locally:")}       ai-trust check ${answer.name} --rescan`
    );
  } else if (normalized === "blocked" || normalized === "warning") {
    lines.push(
      `  ${chalk.cyan("Deep scan:")}          ai-trust check ${answer.name} --rescan`
    );
  } else {
    lines.push(
      `  ${chalk.cyan("Fresh scan:")}         ai-trust check ${answer.name} --rescan`
    );
  }
  lines.push(
    `  ${chalk.cyan("Full project audit:")} ai-trust audit package.json`
  );

  lines.push("");
  return lines.join("\n");
}

export function formatBatchResults(
  response: BatchResponse,
  minTrust: number
): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(
    chalk.bold(
      `  Trust Audit: ${response.meta.total} packages queried, ${response.meta.found} found, ${response.meta.notFound} not found`
    )
  );

  // Table header
  const nameWidth = 40;
  const typeWidth = 14;
  const verdictWidth = 10;
  const levelWidth = 12;
  const scoreWidth = 14;
  const scanWidth = 10;

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

  for (const result of response.results) {
    const name =
      result.name.length > nameWidth - 2
        ? result.name.substring(0, nameWidth - 5) + "..."
        : result.name;

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

    lines.push(
      "  " +
        name.padEnd(nameWidth) +
        (result.packageType || "-").padEnd(typeWidth) +
        colorVerdict(normalized.toUpperCase().padEnd(verdictWidth)) +
        chalk.bold(colorTrust(trustLevelLabel(result.trustLevel).padEnd(levelWidth))) +
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
      chalk.yellow.bold(
        `  ${belowThreshold.length} package(s) below minimum trust level ${minTrust}:`
      )
    );
    for (const pkg of belowThreshold) {
      lines.push(
        chalk.yellow(
          `  ${chalk.dim("\u2502")} ${pkg.name} (trust level ${pkg.trustLevel}, verdict: ${pkg.verdict})`
        )
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
      lines.push(chalk.yellow(`  ${chalk.dim("\u2502")} ${pkg.name}`));
    }
  }

  if (belowThreshold.length === 0 && notFound.length === 0) {
    lines.push(
      chalk.green.bold(
        `  All ${response.meta.found} packages meet minimum trust level ${minTrust}.`
      )
    );
  }

  // Trust level legend
  const hasNonVerified = response.results.some(
    (r) => r.found && r.trustLevel < 4
  );
  if (hasNonVerified) {
    lines.push("");
    lines.push(`  ${trustLevelLegend(minTrust)}`);
  }

  // Next steps
  lines.push(divider("Next Steps"));
  if (notFound.length > 0) {
    lines.push(
      `  ${chalk.cyan("Scan missing:")}      ai-trust audit <file> --scan-missing`
    );
    lines.push(
      `  ${chalk.cyan("Check individual:")}  ai-trust check <name> --rescan`
    );
  }
  if (belowThreshold.length > 0) {
    lines.push(
      `  ${chalk.cyan("Inspect flagged:")}   ai-trust check <name>`
    );
  }
  lines.push(
    `  ${chalk.cyan("Security scan:")}     npx hackmyagent secure .`
  );

  lines.push("");
  return lines.join("\n");
}

export function formatScanResult(result: ScanResult): string {
  const vc = verdictColor(result.verdict);
  const scoreVal = Math.round(result.trustScore * 100);

  const lines: string[] = [
    "",
    `  ${chalk.bold.white(result.packageName)}  ${chalk.dim("local scan")}`,
  ];

  // Verdict
  const failed = result.scan.findings.filter((f) => !f.passed);
  const critical = failed.filter((f) => f.severity === "critical").length;
  const high = failed.filter((f) => f.severity === "high").length;
  const medium = failed.filter((f) => f.severity === "medium").length;
  const low = failed.filter((f) => f.severity === "low").length;
  const total = failed.length;

  let verdictText: string;
  if (critical > 0) {
    verdictText = `${critical} critical issue${critical > 1 ? "s" : ""} found`;
  } else if (high > 0) {
    verdictText = `${high} high-severity issue${high > 1 ? "s" : ""} found`;
  } else if (total > 0) {
    verdictText = `${total} issue${total > 1 ? "s" : ""} found`;
  } else {
    verdictText = "No security issues found";
  }
  lines.push(`  ${chalk.bold(vc(verdictText))}`);

  // Score meters
  lines.push("");
  lines.push(`  Security  ${scoreMeter(result.scan.score, result.scan.maxScore)}`);
  lines.push(`  Trust     ${scoreMeter(scoreVal)}`);

  // Trust level
  const tlColor = trustLevelColor(result.trustLevel);
  lines.push(
    `  Level     ${chalk.bold(tlColor(trustLevelLabel(result.trustLevel)))} ${chalk.dim(`(${result.trustLevel}/4)`)}`
  );

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

    // Show top 10 findings with colored borders
    const limit = Math.min(failed.length, 10);
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
      if (f.message && f.message !== f.name) {
        lines.push(`  ${sevColor("\u2502")} ${f.message}`);
      }
      if (f.fix) {
        lines.push(`  ${sevColor("\u2502")} ${chalk.cyan("Fix:")} ${f.fix}`);
      }
      if (f.attackClass) {
        lines.push(
          `  ${sevColor("\u2502")} ${chalk.dim("Attack:")} ${chalk.cyan(f.attackClass)}`
        );
      }
    }

    if (failed.length > limit) {
      lines.push(
        `\n  ${chalk.dim(`+ ${failed.length - limit} more findings`)}`
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

  // Trust level legend
  if (result.trustLevel < 4) {
    lines.push("");
    lines.push(`  ${trustLevelLegend(result.trustLevel)}`);
  }

  // Next steps
  lines.push(divider("Next Steps"));
  if (result.verdict === "warning" || result.verdict === "blocked") {
    lines.push(
      `  ${chalk.cyan("Remediate:")}         Review findings above before installing`
    );
  }
  if (critical > 0 || high > 0) {
    lines.push(
      `  ${chalk.cyan("Auto-fix:")}          npx hackmyagent secure --fix`
    );
  }
  lines.push(
    `  ${chalk.cyan("Full project audit:")} ai-trust audit package.json`
  );

  lines.push("");
  return lines.join("\n");
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
