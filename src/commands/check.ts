/**
 * ai-trust check - Single package trust lookup with scan-on-demand.
 *
 * When a package isn't in the registry, offers to scan it locally with HMA
 * and optionally contribute results to the community registry.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { RegistryClient, PackageNotFoundError } from "../api/client.js";
import {
  formatCheckResult,
  formatScanResult,
  formatJson,
} from "../output/formatter.js";
import { resolveAndLog } from "../utils/resolve.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import {
  isContributeEnabled,
  queueScanResult,
  flushQueue,
  recordScanAndMaybeShowTip,
  saveContributeChoice,
  sendScanPing,
} from "../telemetry/index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const AI_TRUST_VERSION: string = pkg.version;

interface CheckOptions {
  type?: string;
  scanIfMissing?: boolean;
  contribute?: boolean;
  scan?: boolean; // --no-scan sets this to false (commander strips the "no-" prefix)
  rescan?: boolean;
  /** Enable NanoMind semantic analysis (--deep / --no-deep). Defaults to true. */
  deep?: boolean;
  /** Enable AI-powered analysis (--analyze). Defaults to false. */
  analyze?: boolean;
  /** Internal: set when scanning a package not yet in the registry */
  _firstScan?: boolean;
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check <name>")
    .description("Look up trust information for a single package")
    .option(
      "-t, --type <type>",
      "package type filter (mcp_server, a2a_agent, ai_tool, etc.)"
    )
    .option(
      "--scan-if-missing",
      "auto-scan packages not in registry (non-interactive)"
    )
    .option(
      "--contribute",
      "auto-contribute scan results to community registry"
    )
    .option("--no-scan", "registry lookup only, skip local scan")
    .option("--rescan", "deprecated (local scan is now the default)")
    .option(
      "--no-deep",
      "disable NanoMind semantic analysis (static checks only)"
    )
    .option(
      "--analyze",
      "AI-powered threat analysis using NanoMind Security Analyst"
    )
    .action(async (rawName: string, opts: CheckOptions) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      const name = resolveAndLog(rawName);
      const client = new RegistryClient(globalOpts.registryUrl);

      // --rescan is deprecated — local scan is now the default
      if (opts.rescan) {
        console.error(chalk.dim("  Note: --rescan is deprecated. Local scan is now the default."));
      }

      // --no-scan: registry lookup only (fast mode)
      if (opts.scan === false) {
        try {
          const result = await client.checkTrust(name, opts.type);
          if (globalOpts.json) {
            console.log(formatJson(result));
          } else {
            console.log(formatCheckResult(result));
          }
          if (
            result.found &&
            (result.verdict === "blocked" || result.verdict === "warning" || result.verdict === "warnings" || result.verdict === "failed")
          ) {
            process.exitCode = 2;
          }
        } catch (err) {
          if (err instanceof PackageNotFoundError) {
            handleNoScanNotFound(name, globalOpts);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            if (globalOpts.json) {
              console.log(formatJson({ name, found: false, error: message }));
            } else {
              console.error(`Error: ${message}`);
            }
            process.exitCode = 1;
          }
        }
        return;
      }

      // Default: local HMA scan + registry context
      // Registry is new and most scores are stale, so always scan fresh
      await handleScanFlow(
        name,
        client,
        globalOpts,
        opts,
        `Scanning ${name}...`
      );
    });
}

async function handleNotFound(
  name: string,
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  // Non-interactive mode with --scan-if-missing
  if (opts.scanIfMissing) {
    await handleScanFlow(
      name,
      client,
      globalOpts,
      { ...opts, _firstScan: true },
      `Package "${name}" not found in registry. Scanning...`
    );
    return;
  }

  // Non-TTY: report not found with actionable next steps
  if (!process.stdin.isTTY) {
    if (globalOpts.json) {
      console.log(formatJson({
        name,
        found: false,
        error: `Package "${name}" not found in the OpenA2A Registry.`,
        nextSteps: [
          `ai-trust check ${name} --scan-if-missing`,
          `npx hackmyagent secure <project-dir>`,
        ],
      }));
    } else {
      console.error(`Package "${name}" not found in the OpenA2A Registry.\n`);
      console.error("  Scan it locally:");
      console.error(`    ai-trust check ${name} --scan-if-missing`);
      console.error("");
      console.error("  Or scan your full project:");
      console.error("    npx hackmyagent secure .");
    }
    process.exitCode = 2;
    return;
  }

  // Interactive mode: ask the user
  console.error(
    chalk.gray(`Package "${name}" not found in the OpenA2A Registry.`)
  );

  if (!(await checkHmaReady())) return;

  const shouldScan = await confirm("No trust data yet. Scan it now?", true);
  if (!shouldScan) {
    process.exitCode = 2;
    return;
  }

  await handleScanFlow(name, client, globalOpts, { ...opts, _firstScan: true }, "Scanning...");
}

async function handleScanFlow(
  name: string,
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions,
  statusMessage: string
): Promise<void> {
  if (!(await checkHmaReady())) return;

  console.error(chalk.gray(statusMessage));

  let scanResult: ScanResult;
  try {
    scanResult = await scanPackage(name, { deep: opts.deep ?? true, analyze: opts.analyze });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (globalOpts.json) {
      console.log(formatJson({ name, found: false, error: message }));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  // Output scan results
  if (globalOpts.json) {
    console.log(formatJson(scanResult));
  } else {
    console.log(formatScanResult(scanResult));
  }

  // Set exit code based on verdict (2 = policy signal, matching audit/batch)
  if (scanResult.verdict === "blocked" || scanResult.verdict === "warning") {
    process.exitCode = 2;
  }

  // Anonymous scan ping — fires on every local scan regardless of contribute opt-in.
  // Lets the registry track scan volume and coverage without any findings data.
  sendScanPing(
    name,
    scanResult.verdict,
    Math.round(scanResult.trustScore * 100),
    globalOpts.registryUrl
  );

  // Community contribution flow
  await handleContribute(name, scanResult, globalOpts, opts);
}

let _shownCiContributeTip = false;

async function handleContribute(
  name: string,
  scanResult: ScanResult,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  const alreadyEnabled = opts.contribute || isContributeEnabled() === true;

  // For first scans of missing packages, be more proactive about contribution.
  // Ask once and remember the choice — never spam on repeated scans.
  if (opts._firstScan && !alreadyEnabled) {
    if (process.stdin.isTTY) {
      // Interactive: ask directly after first scan of a missing package
      console.error("");
      console.error(
        chalk.bold("  You just scanned a package with no community trust data.")
      );
      console.error(
        chalk.gray("  Sharing anonymized results helps other developers")
      );
      console.error(
        chalk.gray("  make informed security decisions about AI packages.")
      );
      console.error("");

      const wantsToShare = await confirm(
        "Share this scan with the community?",
        true
      );

      // Persist the choice so we never ask again
      saveContributeChoice(wantsToShare);

      if (wantsToShare) {
        console.error(
          chalk.gray("  (Future scans will auto-share. Change: opena2a config contribute off)")
        );
        await submitContribution(name, scanResult, globalOpts.registryUrl, { type: opts.type });
        return;
      }
    } else {
      // Non-interactive: show a clear call-to-action (once per session, don't repeat)
      if (!_shownCiContributeTip) {
        _shownCiContributeTip = true;
        console.error("");
        console.error(
          chalk.gray(
            "  This is the first scan of this package. Share it with the community:"
          )
        );
        console.error(
          chalk.cyan(
            `    ai-trust check ${name} --scan-if-missing --contribute`
          )
        );
      }
    }
  }

  // Standard contribution flow (tip after 3rd scan, or auto-contribute if enabled)
  const tip = recordScanAndMaybeShowTip();
  if (tip) {
    process.stderr.write(tip + "\n");
  }

  if (!alreadyEnabled) return;

  await submitContribution(name, scanResult, globalOpts.registryUrl, { type: opts.type });
}

async function submitContribution(
  name: string,
  scanResult: ScanResult,
  registryUrl: string,
  opts?: { type?: string }
): Promise<void> {
  try {
    queueScanResult(name, scanResult.scan.findings);
    const ok = await flushQueue(registryUrl);
    if (ok) {
      console.error(
        chalk.green("  Scan shared with the community. Thank you for building trust in AI.")
      );
    }
  } catch {
    // Non-fatal: contribution should never crash the scan
  }

  // Publish full findings via unified endpoint for evidence correlation + consensus
  try {
    const client = new RegistryClient(registryUrl);
    const resp = await client.publishScan({
      name,
      type: opts?.type,
      score: scanResult.scan.score,
      maxScore: scanResult.scan.maxScore,
      tool: "ai-trust",
      toolVersion: AI_TRUST_VERSION,
      verdict: scanResult.verdict === "blocked" ? "fail" : scanResult.verdict === "warning" ? "warn" : "pass",
      findings: scanResult.scan.findings.map(f => ({
        checkId: f.checkId,
        name: f.name,
        severity: f.severity,
        passed: f.passed,
        message: f.message ?? "",
        category: f.category,
        attackClass: f.attackClass,
      })),
      projectType: scanResult.scan.projectType,
      scanTimestamp: new Date().toISOString(),
    });
    if (resp.publishId) {
      console.error(chalk.dim(`  Published to registry (${resp.publishId.slice(0, 8)})`));
    }
  } catch {
    // Non-fatal: contribution should never crash the scan
  }
}

function handleNoScanNotFound(
  name: string,
  globalOpts: { registryUrl: string; json: boolean }
): void {
  if (globalOpts.json) {
    console.log(formatJson({
      name,
      found: false,
      error: `Package "${name}" not found in the OpenA2A Registry.`,
      nextSteps: [
        `ai-trust check ${name} --scan-if-missing`,
        `npx hackmyagent secure <project-dir>`,
      ],
    }));
  } else {
    console.error(
      chalk.gray(`Package "${name}" not found in the OpenA2A Registry.`)
    );
    console.error("");
    console.error("  To scan it locally (requires HackMyAgent):");
    console.error(
      chalk.cyan(`    ai-trust check ${name} --scan-if-missing`)
    );
    console.error("");
    console.error("  Or scan your full project:");
    console.error(chalk.cyan("    npx hackmyagent secure ."));
  }
  process.exitCode = 2;
}

async function checkHmaReady(): Promise<boolean> {
  const available = await isHmaAvailable();
  if (!available) {
    console.error(
      "HMA (HackMyAgent) is required for scanning. Install it with:"
    );
    console.error("  npm install -g hackmyagent");
    process.exitCode = 1;
    return false;
  }
  return true;
}
