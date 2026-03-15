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
  shouldPromptContribute,
  showContributePrompt,
  incrementScanCount,
  buildContributionPayload,
  submitContribution,
} from "../telemetry/index.js";

interface CheckOptions {
  type?: string;
  scanIfMissing?: boolean;
  contribute?: boolean;
  scan?: boolean; // --no-scan sets this to false (commander strips the "no-" prefix)
  rescan?: boolean;
  staleDays?: string;
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
    .option("--no-scan", "never scan, only query registry")
    .option("--rescan", "force re-scan even if data exists")
    .option(
      "--stale-days <n>",
      "consider data stale after N days",
      "90"
    )
    .action(async (rawName: string, opts: CheckOptions) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      const name = resolveAndLog(rawName);
      const client = new RegistryClient(globalOpts.registryUrl);

      try {
        const result = await client.checkTrust(name, opts.type);

        // Check for stale data
        if (result.found && opts.rescan) {
          await handleScanFlow(
            name,
            client,
            globalOpts,
            opts,
            "Re-scanning..."
          );
          return;
        }

        if (globalOpts.json) {
          console.log(formatJson(result));
        } else {
          console.log(formatCheckResult(result));
        }

        if (
          result.found &&
          (result.verdict === "blocked" || result.verdict === "warning")
        ) {
          process.exitCode = 2;
        }
      } catch (err) {
        if (err instanceof PackageNotFoundError && opts.scan !== false) {
          await handleNotFound(name, client, globalOpts, opts);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          if (globalOpts.json) {
            console.log(
              formatJson({ name, found: false, error: message })
            );
          } else {
            console.error(`Error: ${message}`);
          }
          process.exitCode = 1;
        }
      }
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
      opts,
      `Package "${name}" not found in registry. Scanning...`
    );
    return;
  }

  // Non-TTY: just report not found (scan must be opt-in via --scan-if-missing)
  if (!process.stdin.isTTY) {
    const msg = `Package "${name}" not found in the OpenA2A Registry. Use --scan-if-missing to scan locally.`;
    if (globalOpts.json) {
      console.log(formatJson({ name, found: false, error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  // Interactive mode: ask the user
  console.error(
    chalk.gray(`Package "${name}" not found in the OpenA2A Registry.`)
  );

  if (!(await checkHmaReady())) return;

  const shouldScan = await confirm("No trust data yet. Scan it now?", false);
  if (!shouldScan) {
    process.exitCode = 1;
    return;
  }

  await handleScanFlow(name, client, globalOpts, opts, "Scanning...");
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
    scanResult = await scanPackage(name);
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

  // Community contribution flow
  await handleContribute(name, scanResult, globalOpts, opts);
}

async function handleContribute(
  name: string,
  scanResult: ScanResult,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  // Track scan count regardless of contribution setting
  incrementScanCount();

  // Determine contribution mode:
  // 1. --contribute flag: always contribute anonymized telemetry
  // 2. Config enabled: auto-contribute anonymized telemetry
  // 3. Not configured: maybe prompt
  // 4. Config disabled: skip

  if (opts.contribute) {
    await submitAnonymizedTelemetry(name, scanResult, globalOpts.registryUrl);
    return;
  }

  const configEnabled = isContributeEnabled();

  if (configEnabled === true) {
    // Already opted in: auto-contribute anonymized telemetry
    await submitAnonymizedTelemetry(name, scanResult, globalOpts.registryUrl);
    return;
  }

  if (configEnabled === false) {
    // Explicitly opted out: skip
    return;
  }

  // Not yet configured: check if we should prompt
  if (shouldPromptContribute()) {
    const enabled = await showContributePrompt();
    if (enabled) {
      await submitAnonymizedTelemetry(
        name,
        scanResult,
        globalOpts.registryUrl
      );
    }
  }
}

/**
 * Submit anonymized telemetry to the registry (opt-in contribution).
 * Only sends checkId, pass/fail, and severity. No file paths, descriptions, or code.
 */
async function submitAnonymizedTelemetry(
  name: string,
  scanResult: ScanResult,
  registryUrl: string
): Promise<void> {
  try {
    const payload = buildContributionPayload(name, scanResult.scan.findings);
    const result = await submitContribution(payload, registryUrl);

    if (result.success) {
      console.error(
        chalk.green("Anonymized scan data shared with the community.")
      );
    }
    // Silent on failure -- non-blocking
  } catch {
    // Non-fatal: telemetry submission should never crash the scan
  }
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
