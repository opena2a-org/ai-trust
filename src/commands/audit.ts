/**
 * ai-trust audit - Parse dependency files and batch query trust.
 * Supports scanning missing packages locally with HMA.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { RegistryClient } from "@opena2a/registry-client";
import type { TrustAnswer } from "@opena2a/registry-client";
import { parseDependencyFile, detectEcosystem } from "../utils/parser.js";
import {
  formatBatchResults,
  formatJson,
} from "../output/formatter.js";
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

interface AuditOptions {
  minTrust: string;
  scanMissing?: boolean;
  contribute?: boolean;
  /** Enable NanoMind semantic analysis (--deep / --no-deep). Defaults to true. */
  deep?: boolean;
}

export function registerAuditCommand(program: Command): void {
  program
    .command("audit <file>")
    .description(
      "Audit dependencies from package.json or requirements.txt"
    )
    .option(
      "--min-trust <level>",
      "minimum trust level threshold (0-4)",
      "2"
    )
    .option(
      "--scan-missing",
      "scan packages not found in registry using HMA"
    )
    .option(
      "--contribute",
      "contribute scan results to community registry"
    )
    .option(
      "--no-deep",
      "disable NanoMind semantic analysis (static checks only)"
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
        const ecosystem = detectEcosystem(file);

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

        const client = new RegistryClient({
          baseUrl: globalOpts.registryUrl,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        });
        const response = await client.batchQuery(packages);

        // Scan every package the registry hasn't seen. Name-only heuristics
        // aren't safe here: an attacker publishing a squat named like a
        // common library (e.g. @types/malicious-mcp) would otherwise be
        // filtered out and never scanned. Registry-confirmed libraries are
        // already filtered by the `r.found` check — they'll appear in the
        // trust table with their registry trust data and the downstream
        // formatter groups them into the "out of scope" footer.
        const notFound = response.results.filter((r) => !r.found);
        const scanOpts = { deep: opts.deep ?? true, ecosystem };
        if (notFound.length > 0 && opts.scanMissing) {
          await scanMissingPackages(
            notFound,
            response.results,
            opts,
            globalOpts.registryUrl,
            scanOpts
          );
        } else if (
          notFound.length > 0 &&
          !opts.scanMissing &&
          process.stdin.isTTY
        ) {
          // Interactive: offer to scan
          const shouldScan = await confirm(
            `${notFound.length} package(s) not in registry. Scan locally?`,
            true
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
                globalOpts.registryUrl,
                scanOpts
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
        const hasNotFound = response.results.some((r) => !r.found);
        if (belowThreshold || hasNotFound) {
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
  registryUrl: string,
  scanOpts: { deep: boolean; ecosystem?: "npm" | "pypi" } = { deep: true }
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
      const scanResult = await scanPackage(pkg.name, {
        deep: scanOpts.deep,
        ecosystem: scanOpts.ecosystem,
      });

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

      // Anonymous scan ping for adoption tracking
      sendScanPing(
        pkg.name,
        scanResult.verdict,
        Math.round(scanResult.trustScore * 100),
        registryUrl,
        scanOpts.ecosystem
      );
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
      registryUrl,
      scanOpts.ecosystem
    );
  }
}

/**
 * Handle community contribution after audit scanning.
 * Follows the same opt-in flow as check: queue + flush.
 */
async function handleAuditContribution(
  scannedResults: { name: string; scanResult: ScanResult }[],
  opts: AuditOptions,
  registryUrl: string,
  ecosystem: "npm" | "pypi" = "npm"
): Promise<void> {
  const alreadyEnabled = opts.contribute || isContributeEnabled() === true;

  // These are first scans of missing packages — proactively encourage sharing
  if (!alreadyEnabled) {
    if (process.stdin.isTTY) {
      const { confirm } = await import("../utils/prompt.js");
      console.error("");
      console.error(
        chalk.bold(
          `  You just scanned ${scannedResults.length} package(s) with no community trust data.`
        )
      );
      console.error(
        chalk.gray(
          "  Sharing anonymized results helps other developers make informed decisions."
        )
      );
      console.error("");

      const wantsToShare = await confirm(
        "Share these scans with the community?",
        true
      );

      // Persist the choice so we never ask again
      saveContributeChoice(wantsToShare);

      if (wantsToShare) {
        console.error(
          chalk.gray("  (Future scans will auto-share. Change: opena2a config contribute off)")
        );
      } else {
        return;
      }
    } else {
      // Non-interactive: show call-to-action
      console.error("");
      console.error(
        chalk.gray(
          `  ${scannedResults.length} package(s) scanned for the first time. Share with the community:`
        )
      );
      console.error(
        chalk.cyan(
          "    ai-trust audit <file> --scan-missing --contribute"
        )
      );
      return;
    }
  }

  // Show standard tip for scan count tracking
  const tip = recordScanAndMaybeShowTip();
  if (tip) {
    process.stderr.write(tip + "\n");
  }

  try {
    for (const { name, scanResult } of scannedResults) {
      queueScanResult(name, scanResult.scan.findings, 0, ecosystem);
    }
    const ok = await flushQueue(registryUrl);
    if (ok) {
      console.error(
        chalk.green(
          `  Scan data shared for ${scannedResults.length} package(s). Thank you for building trust in AI.`
        )
      );
    }
  } catch {
    // Non-fatal
  }

  // Publish full findings via unified endpoint for evidence correlation + consensus
  const client = new RegistryClient({
    baseUrl: registryUrl,
    userAgent: `ai-trust/${AI_TRUST_VERSION}`,
  });
  for (const { name, scanResult } of scannedResults) {
    try {
      await client.publishScan({
        name,
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
    } catch {
      // Non-fatal: contribution should never crash the audit
    }
  }
}
