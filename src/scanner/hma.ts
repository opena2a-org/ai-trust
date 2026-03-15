/**
 * HMA (HackMyAgent) subprocess runner.
 * Detects availability and runs security scans against downloaded packages.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HmaScanResult {
  score: number;
  maxScore: number;
  findings: HmaFinding[];
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
}

/**
 * Check if HMA (hackmyagent) is available on the system.
 * Tries npx first, then checks for global install.
 */
export async function isHmaAvailable(): Promise<boolean> {
  try {
    await execFileAsync("npx", ["hackmyagent", "--version"], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run HMA security scan against a directory.
 * Uses `npx hackmyagent secure --ci --json <dir>`.
 *
 * @returns Parsed scan results
 * @throws If HMA is not available or scan fails to produce valid output
 */
export async function runHmaScan(
  targetDir: string
): Promise<HmaScanResult> {
  try {
    // HMA may exit non-zero when findings exist, so we handle that
    const { stdout } = await execFileAsync(
      "npx",
      ["hackmyagent", "secure", "--ci", "--json", targetDir],
      { timeout: 120_000 }
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

  return {
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
    })),
    projectType: raw.projectType ?? "unknown",
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };
}
