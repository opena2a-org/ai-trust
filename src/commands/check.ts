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
          process.exitCode = 1;
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

  // Set exit code based on verdict
  if (scanResult.verdict === "blocked" || scanResult.verdict === "warning") {
    process.exitCode = 1;
  }

  // Contribute results to community registry
  await handleContribute(name, scanResult, client, opts);
}

async function handleContribute(
  name: string,
  scanResult: ScanResult,
  client: RegistryClient,
  opts: CheckOptions
): Promise<void> {
  let shouldContribute = false;

  if (opts.contribute) {
    // Non-interactive: auto-contribute
    shouldContribute = true;
  } else if (process.stdin.isTTY) {
    // Interactive: ask
    shouldContribute = await confirm(
      "Contribute results to community registry?",
      false
    );
  }

  if (!shouldContribute) return;

  try {
    const submission = {
      name,
      score: scanResult.scan.score,
      maxScore: scanResult.scan.maxScore,
      findings: scanResult.scan.findings
        .filter((f) => !f.passed)
        .map((f) => ({
          checkId: f.checkId,
          name: f.name,
          severity: f.severity,
          passed: f.passed,
          message: f.message,
          category: f.category,
          attackClass: f.attackClass,
        })),
      projectType: scanResult.scan.projectType,
      scanTimestamp: scanResult.scan.timestamp,
    };

    const publishResult = await client.publishScan(submission);

    if (publishResult.accepted) {
      console.error(
        chalk.green("Scan results contributed to community registry.")
      );
    } else {
      console.error(
        chalk.yellow(
          `Registry did not accept submission: ${publishResult.message || "unknown reason"}`
        )
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.yellow(`Could not publish results: ${message}`));
    // Non-fatal: scan results are still shown locally
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
