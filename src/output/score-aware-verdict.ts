/**
 * Score-aware verdict messaging for ai-trust's local-scan output.
 *
 * ai-trust adjudicates THIRD-PARTY packages, where HMA's generic checks throw
 * highs that are irrelevant to the package type (a filesystem MCP "fails" SQL
 * checks). The JSON `verdict` (`scanner/index.ts deriveVerdict`) is therefore
 * deliberately score-aware: a high finding on a high-scoring package is
 * `warning`, not `blocked`. The human surfaces must agree, or a CI gate reading
 * `--json` sees "warning" while the terminal says "Not safe to ship" on the
 * same scan.
 *
 * This is the single source of truth for ai-trust's human verdict wording: BOTH
 * the top headline and the Observations-block message derive from the same
 * score-aware enum (`safe | warning | blocked`). The shared cli-ui `buildVerdict`
 * stays severity-first and is used by HMA / opena2a for OWN-code scans, where a
 * high finding is actionable — verdict calibration is intentionally
 * context-specific (own-code vs third-party). See
 * `todo/2026-06-08-release-test-cosmetics-cli-cross-tool.md` item 2
 * ([CHIEF-CPO]+[CHIEF-CA] decision, option a).
 */
import type { VerdictStatus, VerdictFinding } from "@opena2a/cli-ui";

/** The score-aware enum produced by `deriveVerdict` (scanner/index.ts). */
export type ScoreAwareVerdictLevel = "safe" | "warning" | "blocked";

export interface VerdictCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface ScoreAwareVerdict {
  /** Maps onto the cli-ui Observations-block verdict status. */
  status: VerdictStatus;
  /** Short top-line headline (replaces the old count-based verdictText). */
  headline: string;
  /** Action-oriented message for the Observations block (names the lead finding). */
  message: string;
}

/** "name in file:line", falling back to checkId / "finding". Mirrors cli-ui buildVerdict. */
function formatLead(f: VerdictFinding): string {
  const label = f.name?.trim() || f.checkId?.trim() || "finding";
  if (f.file) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    return `${label} in ${loc}`;
  }
  return label;
}

/**
 * Concise headline suffix naming the WORST severity bucket only, e.g. " — 2
 * critical" — matching the old verdictText brevity. The full per-severity
 * breakdown lives in the Findings section, so the headline stays scannable
 * even on a kitchen-sink malicious package.
 */
function countSuffix(counts: VerdictCounts): string {
  if (counts.critical > 0) return ` — ${counts.critical} critical`;
  if (counts.high > 0) return ` — ${counts.high} high`;
  if (counts.medium > 0) return ` — ${counts.medium} medium`;
  if (counts.low > 0) return ` — ${counts.low} low`;
  return "";
}

/**
 * Build the human verdict (headline + Observations message + status) from the
 * score-aware enum, so ai-trust's human output never contradicts its `--json`
 * verdict. The lead finding is named to keep the message action-oriented.
 */
export function buildScoreAwareVerdict(
  verdict: ScoreAwareVerdictLevel,
  counts: VerdictCounts,
  findings: VerdictFinding[],
  surface: { kind: string; remote: boolean },
): ScoreAwareVerdict {
  const remote = surface.remote === true;
  // Worst-severity-first lead, matching buildVerdict's selection.
  const leadSeverity =
    counts.critical > 0
      ? "critical"
      : counts.high > 0
        ? "high"
        : counts.medium > 0
          ? "medium"
          : counts.low > 0
            ? "low"
            : null;
  const lead = leadSeverity
    ? findings.find((f) => f.severity === leadSeverity)
    : undefined;
  const leadText = lead ? formatLead(lead) : "";
  const extraCount = Math.max(0, counts.total - 1);
  const extraSuffix = extraCount > 0 ? ` + ${extraCount} more` : "";
  const detail = leadText ? `${leadText}${extraSuffix}. ` : "";

  if (verdict === "blocked") {
    const guidance = remote
      ? "Do not depend on this package as-is."
      : "Fix before using in production.";
    return {
      status: "unsafe",
      headline: `Not safe to ship${countSuffix(counts)}`,
      message: `Not safe to ship. ${detail}${guidance}`,
    };
  }

  if (verdict === "warning") {
    // Local scans own the tree → offer the runnable remediation (no dead ends);
    // remote scans are third-party code the user does not own → review/avoid.
    const guidance = remote
      ? "Review before depending on it, or choose a vetted version."
      : "Run `secure --fix` to auto-remediate where possible, then rescan.";
    return {
      status: "needs-fix",
      headline: `Usable with caveats${countSuffix(counts)}`,
      message: `Usable with caveats. ${detail}${guidance}`,
    };
  }

  // safe: score is high AND no critical/high findings (deriveVerdict guarantees
  // this), but low/medium findings may still be present.
  if (counts.total > 0) {
    const guidance = remote
      ? "Minor findings in the package's own code — review at your discretion."
      : "Minor findings — run `secure --fix` to auto-remediate where possible.";
    return {
      status: "safe",
      headline: `Looks safe — ${counts.total} minor finding${counts.total > 1 ? "s" : ""}`,
      message: `Looks safe to use. ${detail}${guidance}`,
    };
  }
  const kind = surface.kind && surface.kind !== "unknown" ? surface.kind : "package";
  return {
    status: "safe",
    headline: "No security issues found",
    message: `No security issues detected. This ${kind} looks safe to use.`,
  };
}
