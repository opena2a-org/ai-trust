/**
 * ai-trust audit - Parse dependency files and batch query trust.
 * Supports scanning missing packages locally with HMA.
 */

import chalk from "chalk";
import type { Command } from "commander";
import type { TrustAnswer } from "@opena2a/registry-client";
import { createRegistryClient } from "../utils/registry-client.js";
import { parseDependencyFile, detectEcosystem } from "../utils/parser.js";
import { findAuditFile } from "../utils/audit-file.js";
import { stripControlCharacters } from "../output/sanitize.js";
import {
  formatBatchResults,
  formatJson,
} from "../output/formatter.js";
import {
  isHmaAvailable,
  reinstallCommand,
  scanPackage,
  scannerTempDirProblem,
} from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import { shareScans } from "../telemetry/index.js";
import { createRequire } from "node:module";
import { basename } from "node:path";

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
      "--no-contribute",
      "do not share these scans' results with the community registry (overrides config)"
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

        const client = createRegistryClient({
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
        const scanOpts = {
          deep: opts.deep ?? true,
          ecosystem,
          manifestNames: packages.map((p) => p.name),
        };
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
              reportHmaUnavailable();
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
          // The registry's batch answers do not echo the ecosystem the
          // packages were queried under, so tag each result with it: a JSON
          // consumer can then tell a requirements.txt audit (pypi) from a
          // package.json audit (npm) without re-deriving it from the path.
          console.log(
            formatJson({
              ...response,
              results: response.results.map((r) => ({ ...r, ecosystem })),
            })
          );
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
        const fileMissing =
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT";
        const message = fileMissing
          ? `File not found: ${file}`
          : err instanceof Error
            ? err.message
            : String(err);

        if (globalOpts.json) {
          console.log(formatJson({ file, error: message }));
        } else {
          // A registry error can quote the registry's response body.
          console.error(`Error: ${stripControlCharacters(message)}`);
          if (fileMissing) {
            console.error(
              "  No dependencies were checked. The audit command reads package.json or requirements.txt."
            );
            console.error(`  Next: ${missingFileNextCommand(file)}`);
          }
        }
        process.exitCode = 1;
      }
    });
}

/**
 * The command to suggest after `audit <file>` found no file. When the
 * argument was a bare file name and the current directory holds a file
 * audit reads, that file is the next step; otherwise the help, which runs
 * anywhere and lists what the command accepts.
 */
function missingFileNextCommand(file: string): string {
  const found = basename(file) === file ? findAuditFile() : null;
  return found && found !== file ? `ai-trust audit ${found}` : "ai-trust audit --help";
}

/**
 * The dependency-file name a registry answer refers to, or undefined when
 * the file lists no such package. Names are compared ignoring case for npm,
 * and after PEP 503 normalization for PyPI.
 */
function manifestNameFor(
  answerName: string,
  manifestNames: readonly string[],
  ecosystem: "npm" | "pypi" = "npm"
): string | undefined {
  const key = (s: string): string =>
    ecosystem === "pypi" ? s.toLowerCase().replace(/[-_.]+/g, "-") : s.toLowerCase();
  if (manifestNames.includes(answerName)) return answerName;
  return manifestNames.find((m) => key(m) === key(answerName));
}

/** Say why the scanner cannot run, for an isHmaAvailable() that answered false. */
function reportHmaUnavailable(): void {
  const tempDirProblem = scannerTempDirProblem();
  if (tempDirProblem) {
    console.error(
      `HMA (HackMyAgent) is required for scanning, and it could not be started. ${tempDirProblem}`
    );
    return;
  }
  console.error(
    "HMA (HackMyAgent) is required for scanning. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:"
  );
  console.error(`  ${reinstallCommand()}`);
}

/**
 * Scan packages not found in registry and update the results array in-place.
 * Each download uses the name from the dependency file, never the name the
 * registry sent back.
 */
async function scanMissingPackages(
  notFound: TrustAnswer[],
  allResults: TrustAnswer[],
  opts: AuditOptions,
  registryUrl: string,
  scanOpts: {
    deep: boolean;
    ecosystem?: "npm" | "pypi";
    manifestNames: readonly string[];
  }
): Promise<void> {
  const available = await isHmaAvailable();
  if (!available) {
    reportHmaUnavailable();
    return;
  }

  console.error(
    chalk.gray(`Scanning ${notFound.length} missing package(s)...`)
  );

  const scannedResults: { name: string; scanResult: ScanResult }[] = [];

  for (const pkg of notFound) {
    const target = manifestNameFor(pkg.name, scanOpts.manifestNames, scanOpts.ecosystem);
    if (target === undefined) {
      // The name is the one the registry returned: control characters are
      // removed before it is printed.
      console.error(
        chalk.yellow(
          `  Not scanning ${stripControlCharacters(pkg.name)}: the registry answered with a name the dependency file does not list.`
        )
      );
      continue;
    }
    const printedName = stripControlCharacters(target);
    try {
      console.error(chalk.gray(`  Scanning ${printedName}...`));
      const scanResult = await scanPackage(target, {
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

      scannedResults.push({ name: target, scanResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        chalk.yellow(`  Could not scan ${printedName}: ${stripControlCharacters(message)}`)
      );
    }
  }

  // The scan pings and the community contribution for every scanned package:
  // whether to share is decided by decideContribution, with the same inputs
  // as `check`.
  await shareScans("audit", scannedResults, {
    flag: opts.contribute,
    registryUrl,
    ecosystem: scanOpts.ecosystem ?? "npm",
  });
}
