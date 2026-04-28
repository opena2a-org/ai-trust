/**
 * Scanner module - orchestrates package download, HMA scan, and cleanup.
 */

export { downloadPackage } from "./downloader.js";
export type { DownloadResult } from "./downloader.js";
export { isHmaAvailable, runHmaScan } from "./hma.js";
export type { HmaScanResult, HmaFinding, SemanticFinding, AnalystFinding, HmaScanOptions } from "./hma.js";

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadPackage } from "./downloader.js";
import { runHmaScan } from "./hma.js";
import type { HmaScanResult, SemanticFinding, AnalystFinding, HmaScanOptions } from "./hma.js";

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
  /** AnaLM findings (present when --analm is used) */
  analystFindings?: AnalystFinding[];
}

/**
 * Categories that describe local dev-environment setup, not package security.
 * Aligned with HMA's PACKAGE_SCAN_LOCAL_ONLY_CATEGORIES in cli.ts.
 * These are filtered when scanning a downloaded package because findings like
 * "Missing .gitignore" are meaningless for an npm tarball.
 */
const LOCAL_ONLY_CATEGORIES = new Set([
  "git",
  "permissions",
  "environment",
  "logging",
  "claude-code",
  "cursor",
  "vscode",
]);

/**
 * Download a package, scan it with HMA, and return results.
 * Cleans up the temp directory after scanning.
 * Filters local-only findings (git, permissions, etc.) to match HMA check output.
 */
export async function scanPackage(
  name: string,
  options: HmaScanOptions & { ecosystem?: "npm" | "pypi" } = {}
): Promise<ScanResult> {
  const ecosystem = options.ecosystem ?? "npm";
  const download = await downloadPackage(name, ecosystem);

  try {
    // Defense-in-depth: verify the unpacked tarball's package.json `name`
    // matches the requested name BEFORE running runHmaScan. Without this,
    // if `npm pack <name>` ever returned a tarball whose contents identify
    // as a different package (registry redirect, partial-fetch corruption,
    // future typosquat-misroute), --scan-if-missing would publish a trust
    // record under the requested name with content from a different package.
    // The guard does NOT block legitimate scope shorthand resolution
    // (`server-filesystem` → `@modelcontextprotocol/server-filesystem`);
    // see assertPackageMatchesName for the canonical-scope rules.
    if (ecosystem === "npm") {
      await assertPackageMatchesName(download.dir, name);
    }
    const scan = await runHmaScan(download.dir, options);

    // Filter out local-dev-only findings that are meaningless for downloaded packages.
    // This matches HMA's filterLocalOnlyFindings() so scores are consistent.
    const originalCount = scan.findings.filter((f) => !f.passed).length;
    scan.findings = scan.findings.filter(
      (f) => f.passed || !LOCAL_ONLY_CATEGORIES.has(f.category)
    );
    const filteredCount = scan.findings.filter((f) => !f.passed).length;

    // Recalculate score if findings were filtered
    if (filteredCount < originalCount && scan.maxScore > 0) {
      // Use the same exponential decay formula as HMA's calculateScore()
      const SEVERITY_WEIGHTS: Record<string, number> = {
        critical: 25,
        high: 15,
        medium: 8,
        low: 3,
      };
      let weightedSum = 0;
      for (const f of scan.findings) {
        if (!f.passed) {
          weightedSum += SEVERITY_WEIGHTS[f.severity] ?? 8;
        }
      }
      const DECAY_CONSTANT = 150;
      scan.score =
        weightedSum === 0
          ? 100
          : Math.round(100 * Math.exp(-weightedSum / DECAY_CONSTANT));
    }

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

    if (scan.analystFindings && scan.analystFindings.length > 0) {
      result.analystFindings = scan.analystFindings;
    }

    return result;
  } finally {
    await download.cleanup();
  }
}

/**
 * Scan a local directory directly (no download step). Used for adversarial
 * corpus fixtures and any other on-disk target. Skips the LOCAL_ONLY filter
 * because for local sources those categories ARE meaningful (a missing
 * .gitignore in a real repo is a real finding, unlike in an npm tarball).
 */
export async function scanLocalPath(
  targetDir: string,
  options: HmaScanOptions = {},
): Promise<ScanResult> {
  let st;
  try {
    st = await stat(targetDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `scanLocalPath: ${targetDir} could not be read (${code}).`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`scanLocalPath: ${targetDir} is not a directory.`);
  }
  const scan = await runHmaScan(targetDir, options);
  const trustScore = scan.maxScore > 0 ? scan.score / scan.maxScore : 0;
  const trustLevel = deriveTrustLevel(scan);
  const verdict = deriveVerdict(scan);

  const result: ScanResult = {
    packageName: targetDir,
    scan,
    trustScore,
    trustLevel,
    verdict,
  };
  if (scan.semanticFindings && scan.semanticFindings.length > 0) {
    result.semanticFindings = scan.semanticFindings;
  }
  if (scan.analystFindings && scan.analystFindings.length > 0) {
    result.analystFindings = scan.analystFindings;
  }
  return result;
}

/**
 * Verify that the unpacked tarball's package.json `name` matches the
 * requested name. This is a guard against `npm pack <name>` returning the
 * wrong package (or an empty tarball), which would otherwise produce a
 * misleading scan result that the publish path could send to the registry.
 *
 * If package.json is unreadable or has no `name` field, that's also a
 * publish-blocker — we don't have enough information to identify what was
 * actually scanned.
 */
export async function assertPackageMatchesName(
  dir: string,
  requestedName: string,
): Promise<void> {
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(join(dir, "package.json"), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `download verification failed: ${dir}/package.json could not be read (${code}); refusing to scan/publish a package whose identity cannot be confirmed.`,
    );
  }
  let parsed: { name?: unknown };
  try {
    parsed = JSON.parse(pkgRaw) as { name?: unknown };
  } catch {
    throw new Error(
      `download verification failed: ${dir}/package.json is not valid JSON; refusing to scan/publish.`,
    );
  }
  const actualName = typeof parsed.name === "string" ? parsed.name : "";
  if (!actualName) {
    throw new Error(
      `download verification failed: ${dir}/package.json has no "name" field; refusing to scan/publish.`,
    );
  }
  const norm = (s: string): string => s.toLowerCase();
  if (norm(actualName) === norm(requestedName)) return;

  // Allow the legitimate case where the request used unscoped shorthand
  // and npm resolved it to a scoped package (e.g. `server-filesystem` →
  // `@modelcontextprotocol/server-filesystem`). A real npm scope MUST start
  // with `@`, contain exactly one `/`, and have non-empty scope + basename.
  // Anything else (`evil-corp/foo`, `foo/bar/baz`, `/foo`, `@a/b/c`) is
  // rejected — the guard's purpose is refusing to publish under the wrong
  // identity, and only canonical scopes are legitimate identity equivalences
  // for an unscoped request.
  const slashIdx = actualName.indexOf("/");
  const isCanonicalScope =
    actualName.startsWith("@") &&
    slashIdx > 1 &&
    slashIdx === actualName.lastIndexOf("/") &&
    slashIdx < actualName.length - 1;
  if (
    isCanonicalScope &&
    !requestedName.includes("/") &&
    norm(actualName.slice(slashIdx + 1)) === norm(requestedName)
  ) {
    return;
  }

  throw new Error(
    `download verification failed: requested "${requestedName}" but tarball contains "${actualName}". Refusing to publish a trust record under the wrong name.`,
  );
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
