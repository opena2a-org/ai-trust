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
  buildVerdict,
  type CategorizableFinding,
  type CheckBlockInput,
  type CheckTone,
  type NextStepsCta,
  type NotFoundBlockInput,
  type NotFoundTone,
  type VerdictFinding,
} from "@opena2a/cli-ui";
import { mapScanStatusForMeter } from "@opena2a/check-core";
import { classify, tierLabel } from "@opena2a/ai-classifier";
import type { Tier } from "@opena2a/ai-classifier";
import type { TrustAnswer, BatchResponse } from "@opena2a/registry-client";
import type { ScanResult } from "../scanner/index.js";

// ── Visual helpers ─────────────────────────────────────────────���──────

const MINI_METER_WIDTH = 8;

function normalizeScanStatus(status?: string): string | undefined {
  if (!status) return status;
  return status.toLowerCase().trim();
}

// ── ai-trust-specific helpers ─────────────────────────────────────────

function formatScore(trustScore: number, scanStatus?: string): string {
  const status = normalizeScanStatus(scanStatus);
  if (status === "error") return "Scan error";
  if (status === "failed") return "Scan failed";
  const notScanned =
    !status ||
    status === "" ||
    status === "pending" ||
    status === "not_applicable";
  if (notScanned && !hasPassedScan(status)) {
    return "Not scanned";
  }
  return `${Math.round(trustScore * 100)}/100`;
}

function isScanErrorStatus(scanStatus?: string): boolean {
  const status = normalizeScanStatus(scanStatus);
  return status === "error" || status === "failed";
}

function hasPassedScan(scanStatus?: string): boolean {
  const status = normalizeScanStatus(scanStatus);
  return status === "passed" || status === "warnings";
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
    const tier = classify({ name: r.name, packageType: r.packageType }).tier;
    if (tier === "native") native.push(r);
    else if (tier === "unrelated") unrelated.push(r);
    else unknown.push(r);
  }
  return { native, unrelated, unknown };
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


function buildCheckCtas(answer: TrustAnswer, isScanError: boolean): NextStepsCta[] {
  const normalized = normalizeVerdict(answer.verdict);
  const meterGate = mapScanStatusForMeter(answer.scanStatus);
  const isUnscanned = meterGate === undefined && !isScanError;

  const ctas: NextStepsCta[] = [];
  if (isScanError) {
    ctas.push({
      label: "Rescan",
      command: `ai-trust check ${answer.name}`,
      primary: true,
    });
  } else if (isUnscanned || answer.trustLevel <= 2) {
    ctas.push({
      label: "Scan locally",
      command: `ai-trust check ${answer.name}`,
      primary: true,
    });
  } else if (normalized === "blocked" || normalized === "warning") {
    ctas.push({
      label: "Deep scan",
      command: `ai-trust check ${answer.name}`,
      primary: true,
    });
  } else {
    ctas.push({
      label: "Fresh scan",
      command: `ai-trust check ${answer.name}`,
      primary: true,
    });
  }
  ctas.push({
    label: "Full project audit",
    command: "ai-trust audit package.json",
  });
  return ctas;
}

function renderNextStepsLines(ctas: NextStepsCta[]): string[] {
  const { lines } = renderNextSteps({ ctas });
  return lines.map((s) => {
    const bullet = s.tone === "good" ? chalk.green(s.bullet) : chalk.cyan(s.bullet);
    const label = s.tone === "good" ? chalk.bold(s.label) : chalk.cyan(s.label);
    return `  ${bullet} ${label}  ${chalk.dim(s.command)}`;
  });
}

export function formatCheckResult(answer: TrustAnswer): string {
  if (!answer.found) {
    return formatNotFound({
      pkg: answer.name,
      ecosystem: "npm",
    });
  }

  const scanStatusForMeter = mapScanStatusForMeter(answer.scanStatus);
  const block = renderCheckBlock({
    name: answer.name,
    packageType: answer.packageType,
    trustLevel: answer.trustLevel,
    trustScore: answer.trustScore,
    verdict: answer.verdict,
    scanStatus: scanStatusForMeter,
    communityScans: answer.communityScans,
    lastScannedAt: answer.lastScannedAt,
  });

  const isScanError = isScanErrorStatus(answer.scanStatus);
  const out: string[] = [];

  // Header
  out.push("");
  const meta = [...block.header.meta];
  const scanAge = formatScanAge(answer.lastScannedAt);
  if (scanAge) meta.push(`scanned ${scanAge}`);
  const headerMeta = meta.length > 0 ? `  ${chalk.dim(meta.join(" \u00b7 "))}` : "";
  out.push(`  ${chalk.bold.white(block.header.name)}${headerMeta}`);

  // Verdict
  const vc = verdictColor(answer.verdict);
  if (isScanError) {
    out.push(`  ${chalk.bold(chalk.red("Scan failed \u2014 score is unreliable"))}`);
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
    const label = line.label.padEnd(CHECK_LABEL_WIDTH);
    out.push(`  ${label}${paintCheckTone(line.tone, line.value)}`);
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
  out.push(...renderNextStepsLines(buildCheckCtas(answer, isScanError)));

  out.push("");
  return out.join("\n");
}

/**
 * Render a "package not found" block via cli-ui renderNotFoundBlock.
 * Closes F2 (divergent not-found shapes) and F3 (raw git exit codes).
 */
export function formatNotFound(input: NotFoundBlockInput): string {
  const { header, lines: bodyLines } = renderNotFoundBlock(input);
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
  out.push(
    ...renderNextStepsLines([
      {
        label: "Scan locally",
        command: `ai-trust check ${input.pkg} --scan-if-missing`,
        primary: true,
      },
      {
        label: "Full project audit",
        command: "ai-trust audit package.json",
      },
    ])
  );
  out.push("");
  return out.join("\n");
}

export function formatBatchResults(
  response: BatchResponse,
  minTrust: number
): string {
  const lines: string[] = [];
  const { native, unrelated, unknown } = partitionByTier(response.results);

  // Header: summarize the scope split before anything else so the user knows
  // how many of their dependencies are actually in ai-trust's scope.
  lines.push("");
  if (native.length === 0 && unrelated.length > 0) {
    // Edge case: nothing here is an AI package. Show a focused message and
    // route the user to HMA for general security scanning.
    lines.push(
      chalk.bold(
        `  No AI packages found in ${response.meta.total} ${
          response.meta.total === 1 ? "dependency" : "dependencies"
        }`
      )
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
    lines.push(divider("Next Steps"));
    lines.push(`  ${chalk.cyan("General security scan:")}  npx hackmyagent secure .`);
    if (unknown.length > 0) {
      lines.push(`  ${chalk.cyan("Check an AI package:")}     ai-trust check <name>`);
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
  lines.push(chalk.bold("  " + headerParts.join(chalk.dim(" · "))));

  // If we have no AI packages to show but some unknown ones, render just the
  // unknown list with a "check to classify" CTA.
  if (native.length === 0) {
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
      lines.push(divider("Next Steps"));
      lines.push(`  ${chalk.cyan("Classify individually:")} ai-trust check <name>`);
      lines.push(`  ${chalk.cyan("General security scan:")} npx hackmyagent secure .`);
      lines.push("");
      return lines.join("\n");
    }
    // No native + no unrelated + no unknown = empty result set
    lines.push(chalk.dim("  No packages to display."));
    lines.push("");
    return lines.join("\n");
  }

  // Tier 1 trust table — the main event.
  // Table header
  const nameWidth = 36;
  const typeWidth = 14;
  const verdictWidth = 10;
  const levelWidth = 12;
  const scoreWidth = 16;
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

  for (const result of native) {
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
    const scoreVal = Math.round(result.trustScore * 100);
    const isScanError = isScanErrorStatus(result.scanStatus);

    // Score column: mini meter for scanned, text for error/unscanned
    let scoreCell: string;
    if (isScanError) {
      scoreCell = chalk.red.bold("Error") + "         ";
    } else if (scoreDisplay === "Not scanned") {
      scoreCell = chalk.dim("\u2501".repeat(MINI_METER_WIDTH)) + " " + chalk.dim("--");
    } else {
      scoreCell = miniMeter(scoreVal);
    }

    // Color the scan status
    const statusText = result.scanStatus || "-";
    const coloredStatus = scanStatusColor(result.scanStatus)(statusText.padEnd(scanWidth));

    lines.push(
      "  " +
        name.padEnd(nameWidth) +
        (result.packageType || "-").padEnd(typeWidth) +
        colorVerdict(normalized.toUpperCase().padEnd(verdictWidth)) +
        chalk.bold(colorTrust(trustLevelLabel(result.trustLevel).padEnd(levelWidth))) +
        scoreCell + "  " +
        coloredStatus
    );
  }

  // Summary — only consider AI-native packages. Unrelated libraries are out
  // of ai-trust's scope; they don't affect the verdict or trust level checks.
  const belowThreshold = native.filter(
    (r) => r.found && r.trustLevel < minTrust
  );
  const notFound = native.filter((r) => !r.found);
  const errorScans = native.filter(
    (r) => r.found && isScanErrorStatus(r.scanStatus)
  );

  if (belowThreshold.length > 0 || notFound.length > 0 || errorScans.length > 0) {
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
      const pkgScore = Math.round(pkg.trustScore * 100);
      const scoreSection = isScanErrorStatus(pkg.scanStatus)
        ? chalk.red.bold("Error") + chalk.dim(" \u2014 rescan for accurate score")
        : scoreMeter(pkgScore);
      lines.push(
        `  ${chalk.yellow("\u2502")} ${pkg.name}  ${scoreSection}  ${tlc(trustLevelLabel(pkg.trustLevel))} ${chalk.dim(`(${pkg.trustLevel}/4)`)}`
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
  if (belowThreshold.length === 0 && notFound.length === 0 && errorScans.length === 0 && foundNative > 0) {
    lines.push(
      chalk.green.bold(
        `  All ${foundNative} AI ${foundNative === 1 ? "package" : "packages"} meet minimum trust level ${minTrust}.`
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
    const names = unrelated.map((r) => r.name);
    const preview = names.slice(0, 6).join(chalk.dim(", "));
    const more = names.length > 6 ? chalk.dim(` + ${names.length - 6} more`) : "";
    lines.push(`  ${chalk.dim(preview)}${more}`);
  }

  // Unknown: packages we couldn't classify. Surface clearly.
  if (unknown.length > 0) {
    lines.push(divider("Unclassified"));
    lines.push(
      chalk.dim(
        `  Not in registry and not on the known-library list. Classify them:`
      )
    );
    for (const pkg of unknown.slice(0, 6)) {
      lines.push(`  ${chalk.yellow("\u2502")} ${pkg.name}`);
    }
    if (unknown.length > 6) {
      lines.push(`  ${chalk.dim(`  + ${unknown.length - 6} more`)}`);
    }
  }

  // Trust level legend (only meaningful if there are native packages)
  const hasNonVerified = native.some(
    (r) => r.found && r.trustLevel < 4
  );
  if (hasNonVerified) {
    lines.push("");
    lines.push(`  ${trustLevelLegend(minTrust)}`);
  }

  // Next steps
  lines.push(divider("Next Steps"));
  if (errorScans.length > 0) {
    lines.push(
      `  ${chalk.cyan("Rescan errors:")}     ai-trust check <name>`
    );
  }
  if (notFound.length > 0) {
    lines.push(
      `  ${chalk.cyan("Scan missing:")}      ai-trust audit <file> --scan-missing`
    );
    lines.push(
      `  ${chalk.cyan("Check individual:")}  ai-trust check <name>`
    );
  }
  if (belowThreshold.length > 0) {
    lines.push(
      `  ${chalk.cyan("Inspect flagged:")}   ai-trust check <name>`
    );
  }
  if (unknown.length > 0) {
    lines.push(
      `  ${chalk.cyan("Classify unknown:")}  ai-trust check <name>`
    );
  }
  // Always offer HMA for library security — even when the current audit has
  // no libraries, users often come back to audit another file that will.
  lines.push(
    `  ${chalk.cyan("Library security:")}  npx hackmyagent secure .`
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

  // Score meter — show Security (from local scan), not Trust (that's registry)
  lines.push("");
  lines.push(`  Security  ${scoreMeter(result.scan.score, result.scan.maxScore)}`);

  // Trust level
  const tlColor = trustLevelColor(result.trustLevel);
  lines.push(
    `  Level     ${chalk.bold(tlColor(trustLevelLabel(result.trustLevel)))} ${chalk.dim(`(${result.trustLevel}/4)`)}`
  );

  // ── Observations + Verdict ──────────────────────────────────────────
  // Shared block from @opena2a/cli-ui per [CA-030] so ai-trust's local-
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
  const verdictFindings: VerdictFinding[] = failed.map((f) => ({
    severity: f.severity as "critical" | "high" | "medium" | "low",
    name: f.name,
    checkId: f.checkId,
    file: f.file,
    line: f.line,
  }));
  const rawKind = result.scan.projectType?.trim();
  const projectLabel = rawKind && rawKind !== "unknown" ? rawKind : "package";
  const categorySummaries = buildCategorySummaries(categorizable);
  const verdict = buildVerdict(
    { critical, high, medium, low },
    { kind: projectLabel },
    verdictFindings,
  );
  const { lines: obsLines } = renderObservationsBlock({
    surfaces: { kind: projectLabel },
    checks: {
      staticCount: result.scan.findings.length,
      semanticCount: (result.semanticFindings?.length ?? 0),
    },
    categories: categorySummaries,
    verdict,
  });
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
