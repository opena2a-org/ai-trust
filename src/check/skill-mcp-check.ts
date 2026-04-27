/**
 * `ai-trust check skill:<name>` / `check mcp:<name>` orchestrator.
 *
 * Brief: opena2a-org/briefs/check-rich-context-skills-mcp-v1.md (§3, §8).
 *
 * Mirrors hackmyagent/src/check/skill-mcp-check.ts to keep the two
 * CLIs byte-identical on the rich-block render (parity F12 / F13).
 * Adapted to use ai-trust's `@opena2a/registry-client` for the trust
 * lookup; the rest of the helpers (parseRichTarget, fetchNarrative,
 * buildRichBlockInput, render-rich-block) are shared verbatim.
 */

import type { RegistryClient, TrustAnswer } from "@opena2a/registry-client";
import { renderCheckRichBlock, type CheckRichBlockInput } from "@opena2a/cli-ui";
import { fetchNarrative } from "./narrative-fetch.js";
import { buildRichBlockInput } from "./rich-block-adapter.js";
import { printRichBlock, type RichBlockPalette } from "./render-rich-block.js";

const SKILL_PREFIX = "skill:";
const MCP_PREFIX = "mcp:";

export interface ParsedRichTarget {
  artifactType: "skill" | "mcp";
  name: string;
}

/**
 * Parse `skill:<name>` / `mcp:<name>` prefixes. Returns null when the
 * input has no recognised prefix — the caller routes through the
 * existing AI-classifier dispatch.
 */
export function parseRichTarget(target: string): ParsedRichTarget | null {
  if (target.startsWith(SKILL_PREFIX)) {
    const name = target.slice(SKILL_PREFIX.length);
    if (name.length === 0) return null;
    return { artifactType: "skill", name };
  }
  if (target.startsWith(MCP_PREFIX)) {
    const name = target.slice(MCP_PREFIX.length);
    if (name.length === 0) return null;
    return { artifactType: "mcp", name };
  }
  return null;
}

/**
 * Map a registry verdict + scanStatus to the rich-block trustVerdict
 * tier. Same logic as HMA's deriveTrustVerdict (parity F12 / F13).
 */
export function deriveTrustVerdict(
  verdict: string | undefined,
  trustLevel: number | undefined,
  scanStatus: string | undefined,
): "VERIFIED" | "LISTED" | "LISTED_UNSCANNED" | "BLOCKED" {
  const v = (verdict ?? "").toLowerCase();
  if (v === "blocked" || trustLevel === 0) return "BLOCKED";
  if (trustLevel === 4 || v === "verified") return "VERIFIED";
  if (scanStatus !== "completed") return "LISTED_UNSCANNED";
  return "LISTED";
}

export interface CheckSkillOrMcpOptions {
  parsed: ParsedRichTarget;
  registryUrl: string;
  client: RegistryClient;
  userAgent: string;
  /** Tool name for the secrets-block report command (e.g. "ai-trust"). */
  reportTool: string;
  /** Pre-built palette to paint the output. */
  palette: RichBlockPalette;
  /** Optional explicit version pin; defaults to registry's "latest". */
  version?: string;
  /**
   * Suppress the human-readable rich-block render. Used by `--json`
   * callers and the opena2a-parity harness so output is parseable.
   * The orchestrator still builds and returns `result.input`.
   */
  silent?: boolean;
}

export interface CheckSkillOrMcpResult {
  /** True when the rich block was printed. False → caller falls back. */
  rendered: boolean;
  /** Raw input passed to renderCheckRichBlock — useful for tests / --json. */
  input?: CheckRichBlockInput;
}

/**
 * Run the rich-block path. Returns `{rendered: false}` when the
 * narrative is unavailable; caller falls back to the existing
 * classifier path.
 */
export async function checkSkillOrMcp(
  options: CheckSkillOrMcpOptions,
): Promise<CheckSkillOrMcpResult> {
  const { parsed, client } = options;

  const version = options.version && options.version.length > 0
    ? options.version
    : "latest";

  const narrative = await fetchNarrative({
    registryUrl: options.registryUrl,
    artifactType: parsed.artifactType,
    name: parsed.name,
    version,
    userAgent: options.userAgent,
  });
  if (!narrative) {
    return { rendered: false };
  }

  // Trust lookup is best-effort — a freshly-seeded narrative may not
  // yet have a trust record. Sparse / missing trust degrades the
  // header to LISTED_UNSCANNED but the narrative carries the bulk
  // of the rich block.
  let trust: TrustAnswer | null = null;
  try {
    trust = await client.checkTrust(parsed.name);
  } catch {
    trust = null;
  }

  const trustInput =
    trust && trust.found
      ? {
          trustVerdict: deriveTrustVerdict(
            trust.verdict,
            trust.trustLevel,
            trust.scanStatus,
          ),
          trustScore:
            trust.scanStatus === "completed"
              ? Math.round(trust.trustScore * 100)
              : undefined,
          scanStatus: trust.scanStatus,
          lastScanAge: formatScanAge(trust.lastScannedAt),
          latestVersionLabel: narrative.packageVersion,
          communityScans: trust.communityScans,
        }
      : {
          trustVerdict: "LISTED_UNSCANNED" as const,
          latestVersionLabel: narrative.packageVersion,
        };

  const input = buildRichBlockInput({
    name: parsed.name,
    artifactType: parsed.artifactType,
    narrative,
    trust: trustInput,
    reportTool: options.reportTool,
  });

  if (!input) {
    return { rendered: false };
  }

  if (options.silent) {
    return { rendered: true, input };
  }

  const rendered = renderCheckRichBlock(input);
  printRichBlock(rendered, { palette: options.palette });

  return { rendered: true, input };
}

function formatScanAge(lastScannedAt?: string): string | undefined {
  if (!lastScannedAt) return undefined;
  const scanned = new Date(lastScannedAt);
  if (Number.isNaN(scanned.getTime())) return undefined;
  const days = Math.floor(
    (Date.now() - scanned.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1mo ago";
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1y ago" : `${years}y ago`;
}
