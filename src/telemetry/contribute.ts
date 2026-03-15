/**
 * Community Contribution Module
 *
 * Sends anonymized scan findings to the OpenA2A Registry.
 * No PII, no source code -- only check pass/fail results.
 */

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname, type as osType, userInfo } from "os";
import { join } from "path";
import { createRequire } from "node:module";
import type { HmaFinding } from "../scanner/hma.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const VERSION: string = pkg.version;

/** Anonymized finding sent to the registry. Only check ID, result, and severity. */
export interface ContributionFinding {
  checkId: string;
  result: "pass" | "fail";
  severity: string;
}

/** Payload submitted to the telemetry endpoint. */
export interface ContributionPayload {
  contributorToken: string;
  packageName: string;
  packageVersion: string;
  ecosystem: "npm" | "pypi" | "github";
  scanTimestamp: string;
  findings: ContributionFinding[];
  aiTrustVersion: string;
  osType: "linux" | "macos" | "windows";
}

/** Result of submitting a contribution. */
export interface ContributionResult {
  success: boolean;
  scanId?: string;
  error?: string;
}

/**
 * Resolve the path to the OpenA2A home directory.
 * Respects the OPENA2A_HOME env var, defaults to ~/.opena2a.
 */
function getOpena2aHome(): string {
  return (
    process.env.OPENA2A_HOME || join(require("os").homedir(), ".opena2a")
  );
}

/**
 * Generate a stable per-device contributor token.
 *
 * SHA256(hostname + username + random salt stored at ~/.opena2a/contributor-salt).
 * The salt is generated once on first call and persisted locally.
 * Shared with hackmyagent so the same device gets the same token.
 */
export function generateContributorToken(): string {
  const home = getOpena2aHome();
  const saltPath = join(home, "contributor-salt");

  let salt: string;
  if (existsSync(saltPath)) {
    salt = readFileSync(saltPath, "utf-8").trim();
  } else {
    salt = randomBytes(32).toString("hex");
    mkdirSync(home, { recursive: true });
    writeFileSync(saltPath, salt, { mode: 0o600 });
  }

  const input = `${hostname()}|${userInfo().username}|${salt}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Map the Node.js os.type() value to the server-accepted osType enum.
 */
function resolveOsType(): "linux" | "macos" | "windows" {
  const t = osType();
  if (t === "Darwin") return "macos";
  if (t === "Windows_NT") return "windows";
  return "linux";
}

/**
 * Build an anonymized contribution payload from scan findings.
 *
 * PRIVACY: This function intentionally strips all sensitive fields.
 * The output contains ONLY: checkId, pass/fail result, and severity.
 * No file paths, line numbers, descriptions, fix text, or code content.
 */
export function buildContributionPayload(
  packageName: string,
  findings: HmaFinding[]
): ContributionPayload {
  const contributionFindings: ContributionFinding[] = findings.map((f) => ({
    checkId: f.checkId,
    result: f.passed ? ("pass" as const) : ("fail" as const),
    severity: f.severity,
  }));

  return {
    contributorToken: generateContributorToken(),
    packageName,
    packageVersion: "",
    ecosystem: "npm",
    scanTimestamp: new Date().toISOString(),
    findings: contributionFindings,
    aiTrustVersion: VERSION,
    osType: resolveOsType(),
  };
}

/**
 * Submit an anonymized contribution payload to the OpenA2A Registry.
 *
 * POST to https://api.oa2a.org/api/v1/telemetry/scan
 * Timeout: 10 seconds. Non-blocking: failures are logged as warnings, never crash the scan.
 */
export async function submitContribution(
  payload: ContributionPayload,
  registryUrl?: string
): Promise<ContributionResult> {
  const baseUrl = registryUrl || "https://api.oa2a.org";
  const url = `${baseUrl}/api/v1/telemetry/scan`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `ai-trust/${VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        error: `HTTP ${response.status}: ${body}`.substring(0, 200),
      };
    }

    const result = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      scanId: (result.scanId as string) || undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // AbortError means timeout
    if (message.includes("abort") || message.includes("Abort")) {
      return { success: false, error: "Request timed out (10s)" };
    }
    return { success: false, error: message };
  }
}
