/**
 * ai-trust audit - Parse dependency files and batch query trust.
 * Supports scanning missing packages locally with HMA.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { RegistryClient } from "../api/client.js";
import type { TrustAnswer } from "../api/client.js";
import { parseDependencyFile } from "../utils/parser.js";
import {
  formatBatchResults,
  formatJson,
} from "../output/formatter.js";
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

interface AuditOptions {
  minTrust: string;
  scanMissing?: boolean;
  contribute?: boolean;
}

export function registerAuditCommand(program: Command): void {
  program
    .command("audit <file>")
    .description(
      "Audit dependencies from package.json or requirements.txt"
    )
    .option(
      "--min-trust <level>",
      "minimum trust level threshold",
      "3"
    )
    .option(
      "--scan-missing",
      "scan packages not found in registry using HMA"
    )
    .option(
      "--contribute",
      "contribute scan results to community registry"
    )
    .action(async (file: string, opts: AuditOptions) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      const minTrust = parseInt(opts.minTrust, 10);
      if (isNaN(minTrust) || minTrust < 0 || minTrust > 4) {
        console.error("Error: --min-trust must be a number between 0 and 4");
        process.exitCode = 1;
        return;
      }

      try {
        const packages = await parseDependencyFile(file);

        if (packages.length === 0) {
          console.log("No dependencies found in the specified file.");
          return;
        }

        if (packages.length > 100) {
          console.error(
            `Error: Too many dependencies (${packages.length}). The batch API supports a maximum of 100 packages per request.`
          );
          process.exitCode = 1;
          return;
        }

        const client = new RegistryClient(globalOpts.registryUrl);
        const response = await client.batchQuery(packages);

        // Scan missing packages if requested
        const notFound = response.results.filter((r) => !r.found);
        if (notFound.length > 0 && opts.scanMissing) {
          await scanMissingPackages(
            notFound,
            response.results,
            opts,
            globalOpts.registryUrl
          );
        } else if (
          notFound.length > 0 &&
          !opts.scanMissing &&
          process.stdin.isTTY
        ) {
          // Interactive: offer to scan
          const shouldScan = await confirm(
            `${notFound.length} package(s) not in registry. Scan locally?`,
            false
          );
          if (shouldScan) {
            if (!(await isHmaAvailable())) {
              console.error(
                "HMA (HackMyAgent) is required for scanning. Install it with:"
              );
              console.error("  npm install -g hackmyagent");
            } else {
              await scanMissingPackages(
                notFound,
                response.results,
                opts,
                globalOpts.registryUrl
              );
            }
          }
        }

        if (globalOpts.json) {
          console.log(formatJson(response));
        } else {
          console.log(formatBatchResults(response, minTrust));
        }

        const belowThreshold = response.results.some(
          (r) => r.found && r.trustLevel < minTrust
        );
        if (belowThreshold) {
          process.exitCode = 2;
        }
      } catch (err: unknown) {
        let message: string;
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          message = `File not found: ${file}`;
        } else {
          message = err instanceof Error ? err.message : String(err);
        }

        if (globalOpts.json) {
          console.log(formatJson({ file, error: message }));
        } else {
          console.error(`Error: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}

/**
 * Scan packages not found in registry and update the results array in-place.
 */
async function scanMissingPackages(
  notFound: TrustAnswer[],
  allResults: TrustAnswer[],
  opts: AuditOptions,
  registryUrl: string
): Promise<void> {
  const available = await isHmaAvailable();
  if (!available) {
    console.error(
      "HMA (HackMyAgent) is required for scanning. Install it with:"
    );
    console.error("  npm install -g hackmyagent");
    return;
  }

  console.error(
    chalk.gray(`Scanning ${notFound.length} missing package(s)...`)
  );

  const scannedResults: { name: string; scanResult: ScanResult }[] = [];

  for (const pkg of notFound) {
    try {
      console.error(chalk.gray(`  Scanning ${pkg.name}...`));
      const scanResult = await scanPackage(pkg.name);

      // Update the result in-place
      const idx = allResults.findIndex((r) => r.name === pkg.name);
      if (idx !== -1) {
        allResults[idx] = {
          ...allResults[idx],
          found: true,
          trustLevel: scanResult.trustLevel,
          trustScore: scanResult.trustScore,
          verdict: scanResult.verdict,
          scanStatus: "local",
        };
      }

      scannedResults.push({ name: pkg.name, scanResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        chalk.yellow(`  Could not scan ${pkg.name}: ${message}`)
      );
    }
  }

  // Handle community contribution for all scanned packages
  if (scannedResults.length > 0) {
    await handleAuditContribution(
      scannedResults,
      opts,
      registryUrl
    );
  }
}

/**
 * Handle community contribution after audit scanning.
 * Follows the same opt-in flow as check: config -> prompt -> submit.
 */
async function handleAuditContribution(
  scannedResults: { name: string; scanResult: ScanResult }[],
  opts: AuditOptions,
  registryUrl: string
): Promise<void> {
  // Track scan count for each scanned package
  for (let i = 0; i < scannedResults.length; i++) {
    incrementScanCount();
  }

  if (opts.contribute) {
    for (const { name, scanResult } of scannedResults) {
      await submitAnonymizedTelemetry(name, scanResult, registryUrl);
    }
    return;
  }

  const configEnabled = isContributeEnabled();

  if (configEnabled === true) {
    // Already opted in: auto-contribute anonymized telemetry
    for (const { name, scanResult } of scannedResults) {
      await submitAnonymizedTelemetry(name, scanResult, registryUrl);
    }
    return;
  }

  if (configEnabled === false) {
    return;
  }

  // Not yet configured: check if we should prompt
  if (shouldPromptContribute()) {
    const enabled = await showContributePrompt();
    if (enabled) {
      for (const { name, scanResult } of scannedResults) {
        await submitAnonymizedTelemetry(name, scanResult, registryUrl);
      }
    }
  }
}

/**
 * Submit anonymized telemetry to the registry (opt-in contribution).
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
        chalk.green(`  Anonymized scan data shared: ${name}`)
      );
    }
  } catch {
    // Non-fatal
  }
}
