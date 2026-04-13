/**
 * HMA (HackMyAgent) subprocess runner.
 * Detects availability and runs security scans against downloaded packages.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SemanticFinding {
  intentClass: string;
  attackClass: string;
  confidence: number;
  file: string;
}

export interface AnalystFinding {
  taskType: string;
  result: Record<string, unknown>;
  confidence: number;
  modelVersion: string;
  durationMs: number;
  backend: string;
}

export interface HmaScanResult {
  score: number;
  maxScore: number;
  findings: HmaFinding[];
  /** Semantic analysis results from NanoMind (present when --deep is used) */
  semanticFindings?: SemanticFinding[];
  /** AnaLM findings (present when --analm is used) */
  analystFindings?: AnalystFinding[];
  projectType: string;
  timestamp: string;
}

export interface HmaFinding {
  checkId: string;
  name: string;
  description: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  passed: boolean;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  /** Attack taxonomy class this finding maps to (from HMA taxonomy) */
  attackClass?: string;
}

/**
 * Resolve the HMA binary. Resolution order:
 * 1. Bundled: node_modules/.bin/hackmyagent (always correct version)
 * 2. Global: hackmyagent in PATH
 * 3. npx fallback (may use stale cache)
 *
 * Returns { cmd, prefixArgs } where:
 *   cmd="/path/to/hackmyagent", prefixArgs=[]  (bundled or global)
 *   cmd="npx", prefixArgs=["hackmyagent"]      (npx fallback)
 */
let _resolvedHma: { cmd: string; prefixArgs: string[] } | null = null;

async function resolveHma(): Promise<{ cmd: string; prefixArgs: string[] }> {
  if (_resolvedHma) return _resolvedHma;

  // 1. Try bundled binary (hackmyagent is a direct dependency)
  try {
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/scanner/ to package root, then into node_modules/.bin
    const bundled = join(thisDir, "..", "..", "node_modules", ".bin", "hackmyagent");
    await execFileAsync(bundled, ["--version"], { timeout: 10_000 });
    _resolvedHma = { cmd: bundled, prefixArgs: [] };
    return _resolvedHma;
  } catch {
    // Bundled not found (dev mode, or dependency not installed)
  }

  // 2. Try global binary
  try {
    await execFileAsync("hackmyagent", ["--version"], { timeout: 10_000 });
    _resolvedHma = { cmd: "hackmyagent", prefixArgs: [] };
    return _resolvedHma;
  } catch {
    // Not found globally
  }

  // 3. Fall back to npx
  _resolvedHma = { cmd: "npx", prefixArgs: ["hackmyagent"] };
  return _resolvedHma;
}

/**
 * Check if HMA (hackmyagent) is available on the system.
 */
export async function isHmaAvailable(): Promise<boolean> {
  try {
    const hma = await resolveHma();
    await execFileAsync(hma.cmd, [...hma.prefixArgs, "--version"], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run HMA security scan against a directory.
 *
 * @returns Parsed scan results
 * @throws If HMA is not available or scan fails to produce valid output
 */
export interface HmaScanOptions {
  /** Enable NanoMind semantic analysis via HMA --deep flag. Defaults to true. */
  deep?: boolean;
  /** Enable AnaLM analysis via HMA --analm flag. Defaults to false. */
  analm?: boolean;
}

export async function runHmaScan(
  targetDir: string,
  options: HmaScanOptions = {}
): Promise<HmaScanResult> {
  const deep = options.deep ?? true;
  const analm = options.analm ?? false;
  const hma = await resolveHma();
  const args = [...hma.prefixArgs, "secure", "--format", "json"];
  if (deep) {
    args.push("--deep");
  }
  if (analm) {
    args.push("--analm");
  }
  args.push(targetDir);

  try {
    return await runHmaWithArgs(hma.cmd, args, deep);
  } catch (err: unknown) {
    // If --analm caused "unknown option", retry without it (older HMA version)
    if (analm && isUnknownOptionError(err, "--analm")) {
      const fallbackArgs = args.filter((a) => a !== "--analm");
      return runHmaWithArgs(hma.cmd, fallbackArgs, deep);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`HMA scan failed: ${message}`);
  }
}

function isUnknownOptionError(err: unknown, flag: string): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
  const message = err instanceof Error ? err.message : "";
  return (stderr + message).includes(`unknown option '${flag}'`);
}

async function runHmaWithArgs(
  cmd: string,
  args: string[],
  deep: boolean,
): Promise<HmaScanResult> {
  try {
    const { stdout } = await execFileAsync(
      cmd,
      args,
      { timeout: deep ? 180_000 : 120_000 }
    );

    return parseHmaOutput(stdout);
  } catch (err: unknown) {
    // HMA exits with code 1 when it finds issues but still outputs JSON
    if (
      err &&
      typeof err === "object" &&
      "stdout" in err &&
      typeof (err as { stdout: unknown }).stdout === "string"
    ) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout.trim()) {
        try {
          return parseHmaOutput(stdout);
        } catch {
          // Fall through to throw
        }
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`HMA scan failed: ${message}`);
  }
}

function parseHmaOutput(stdout: string): HmaScanResult {
  // HMA may output non-JSON lines before the JSON; find the JSON object
  const lines = stdout.split("\n");
  let jsonStr = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      jsonStr = lines.slice(i).join("\n");
      break;
    }
  }

  if (!jsonStr) {
    throw new Error("No JSON output found from HMA scan");
  }

  const raw = JSON.parse(jsonStr);

  const result: HmaScanResult = {
    score: raw.score ?? 0,
    maxScore: raw.maxScore ?? 100,
    findings: (raw.findings ?? []).map((f: Record<string, unknown>) => ({
      checkId: f.checkId ?? "",
      name: f.name ?? "",
      description: f.description ?? "",
      category: f.category ?? "",
      severity: f.severity ?? "low",
      passed: f.passed ?? true,
      message: f.message ?? "",
      file: f.file,
      line: f.line,
      fix: f.fix,
      attackClass: f.attackClass as string | undefined,
    })),
    projectType: raw.projectType ?? "unknown",
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };

  // Parse NanoMind semantic findings when present (from --deep mode)
  if (Array.isArray(raw.semanticFindings) && raw.semanticFindings.length > 0) {
    result.semanticFindings = raw.semanticFindings.map(
      (sf: Record<string, unknown>) => ({
        intentClass: (sf.intentClass as string) ?? "unknown",
        attackClass: (sf.attackClass as string) ?? "unknown",
        confidence: typeof sf.confidence === "number" ? sf.confidence : 0,
        file: (sf.file as string) ?? "",
      })
    );
  }

  // Parse analyst findings when present (from --analyze mode)
  if (Array.isArray(raw.analystFindings) && raw.analystFindings.length > 0) {
    result.analystFindings = raw.analystFindings.map(
      (af: Record<string, unknown>) => ({
        taskType: (af.taskType as string) ?? "unknown",
        result: (af.result as Record<string, unknown>) ?? {},
        confidence: typeof af.confidence === "number" ? af.confidence : 0,
        modelVersion: (af.modelVersion as string) ?? "unknown",
        durationMs: typeof af.durationMs === "number" ? af.durationMs : 0,
        backend: (af.backend as string) ?? "unknown",
      })
    );
  }

  return result;
}
