/**
 * Output formatting for trust query results.
 * Supports colored terminal output and raw JSON.
 */

import chalk from "chalk";
import type { TrustAnswer, BatchResponse } from "../api/client.js";
import type { ScanResult } from "../scanner/index.js";

function verdictColor(verdict: string): (text: string) => string {
  switch (verdict) {
    case "safe":
      return chalk.green;
    case "warning":
      return chalk.yellow;
    case "blocked":
      return chalk.red;
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

export function formatCheckResult(answer: TrustAnswer): string {
  if (!answer.found) {
    return [
      chalk.bold(`  ${answer.name}`),
      chalk.gray(`  Type: ${answer.packageType || "unknown"}`),
      chalk.gray("  Status: Not found in registry"),
      "",
    ].join("\n");
  }

  const colorVerdict = verdictColor(answer.verdict);
  const colorTrust = trustLevelColor(answer.trustLevel);

  const lines: string[] = [
    chalk.bold(`  ${answer.name}`),
    `  Type:           ${answer.packageType || "unknown"}`,
    `  Verdict:        ${colorVerdict(answer.verdict.toUpperCase())}`,
    `  Trust Level:    ${colorTrust(trustLevelLabel(answer.trustLevel))} (${answer.trustLevel}/4)`,
    `  Trust Score:    ${answer.trustScore.toFixed(2)}`,
    `  Scan Status:    ${answer.scanStatus || "unknown"}`,
  ];

  if (answer.dependencies && answer.dependencies.totalDeps > 0) {
    const deps = answer.dependencies;
    lines.push("");
    lines.push(chalk.bold("  Dependencies"));
    lines.push(`  Total:          ${deps.totalDeps}`);
    lines.push(`  Vulnerable:     ${deps.vulnerableDeps > 0 ? chalk.red(String(deps.vulnerableDeps)) : chalk.green("0")}`);
    lines.push(`  Min Trust:      ${deps.minTrustLevel}/4`);
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
  const scoreWidth = 8;
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
    const colorVerdict = verdictColor(result.verdict);
    const colorTrust = trustLevelColor(result.trustLevel);

    const name = result.name.length > nameWidth - 2
      ? result.name.substring(0, nameWidth - 5) + "..."
      : result.name;

    lines.push(
      "  " +
        name.padEnd(nameWidth) +
        (result.packageType || "-").padEnd(typeWidth) +
        colorVerdict(result.verdict.toUpperCase().padEnd(verdictWidth)) +
        colorTrust(trustLevelLabel(result.trustLevel).padEnd(levelWidth)) +
        (result.found ? result.trustScore.toFixed(2) : "-").toString().padEnd(scoreWidth) +
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
      chalk.gray(
        `  [?] ${notFound.length} package(s) not found in registry:`
      )
    );
    for (const pkg of notFound) {
      lines.push(chalk.gray(`      - ${pkg.name}`));
    }
  }

  if (belowThreshold.length === 0 && notFound.length === 0) {
    lines.push(
      chalk.green(
        `  All ${response.meta.found} packages meet minimum trust level ${minTrust}.`
      )
    );
  }

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
    `  Trust Score:    ${result.trustScore.toFixed(2)}`,
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

  lines.push("");
  return lines.join("\n");
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
