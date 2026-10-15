/**
 * ai-trust check - Single package trust check.
 *
 * By default, downloads the package and scans it locally with HMA, whether
 * or not the registry has it, and optionally contributes the results to the
 * community registry. --no-scan returns the registry's answer only.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { classify } from "@opena2a/ai-classifier";
import { PackageNotFoundError } from "@opena2a/registry-client";
import type { RegistryClient, TrustAnswer } from "@opena2a/registry-client";
import { createRegistryClient } from "../utils/registry-client.js";
import {
  ecosystemSuffix,
  formatCheckResult,
  formatScanResult,
  formatJson,
  formatNotFound,
} from "../output/formatter.js";
import { buildNotFoundOutput, translateDownloadError } from "@opena2a/check-core";
import { logResolved } from "../utils/resolve.js";
import { stripControlCharacters } from "../output/sanitize.js";
import { isHmaAvailable, reinstallCommand, scanPackage, scanLocalPath } from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import { shareScans } from "../telemetry/index.js";
import { checkSkillOrMcp } from "../check/skill-mcp-check.js";
import { classifyCheckTarget } from "../check/target.js";
import type { InvalidTarget, PackageTarget } from "../check/target.js";
import { checkCitation } from "../utils/cli-prefix.js";
import { shellArg } from "../utils/shell-arg.js";
import { buildCheckJson } from "../output/check-json.js";
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
  /** Enable AnaLM analysis (--analm). Defaults to false. */
  analm?: boolean;
  /** Scan a local directory directly, skipping the npm-pack download. */
  scanPath?: string;
}

export function registerCheckCommand(program: Command): void {
  const checkCmd = program
    .command("check <name>")
    .description("Download and scan a single package, then report its trust verdict")
    .option(
      "-t, --type <type>",
      "package type filter (mcp_server, a2a_agent, ai_tool, etc.)"
    )
    .option(
      "--scan-if-missing",
      "deprecated (every package is scanned by default)"
    )
    .option(
      "--contribute",
      "auto-contribute scan results to community registry"
    )
    .option(
      "--no-contribute",
      "do not share this scan's results with the community registry (overrides config)"
    )
    .option("--no-scan", "registry lookup only, skip local scan")
    .option("--rescan", "deprecated (local scan is now the default)")
    .option(
      "--no-deep",
      "disable NanoMind semantic analysis (static checks only)"
    )
    .option(
      "--analm",
      "AI-powered threat analysis using AnaLM"
    )
    .option(
      "--scan-path <dir>",
      "scan a local directory directly (skip npm-pack download); used for adversarial-corpus fixtures and on-disk scans"
    )
    .action(async (rawName: string, opts: CheckOptions) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      // --scan-path: scan a local directory directly. No registry lookup, no
      // download step, no contribution. Used for adversarial-corpus fixtures
      // and any on-disk target. The <name> argument is treated as a label
      // for the result (typically the fixture path).
      if (opts.scanPath) {
        if (!(await isHmaAvailable())) {
          console.error(
            chalk.red(`error: HMA is not available. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it: ${reinstallCommand()}`),
          );
          process.exit(2);
        }
        let result;
        try {
          result = await scanLocalPath(opts.scanPath, {
            deep: opts.deep ?? true,
            analm: opts.analm ?? false,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(chalk.red(`error: ${msg}`));
          console.error(
            chalk.dim(
              "Fix: pass --scan-path to a directory that exists and is readable.",
            ),
          );
          process.exit(2);
        }
        // Override packageName with the user-supplied name so output is
        // labeled clearly when the same fixture is invoked under different
        // names (e.g. release-smoke harness uses surface/intent/fixture).
        result.packageName = rawName;
        if (globalOpts.json) {
          console.log(formatJson(buildCheckJson({ kind: "scan", scan: result })));
        } else {
          // --scan-path scans the user's own on-disk tree → local verdict.
          console.log(formatScanResult(result, { remote: false }));
        }
        return;
      }

      // The target is read once; every step below reads the result.
      const target = classifyCheckTarget(rawName);

      // Rich-block dispatch (skill: / mcp: prefix). Mirrors HMA's
      // src/check/ module for parity F12 / F13. When the registry
      // has a fresh narrative, render the rich block and exit.
      // Otherwise fall through to the existing classifier flow.
      let pkg: PackageTarget | InvalidTarget;
      if (target.kind === "skill" || target.kind === "mcp") {
        const richClient = createRegistryClient({
          baseUrl: globalOpts.registryUrl,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        });
        const result = await checkSkillOrMcp({
          parsed: { artifactType: target.kind, name: target.name },
          registryUrl: globalOpts.registryUrl,
          client: richClient,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
          reportTool: "ai-trust",
          silent: !!globalOpts.json,
          palette: {
            reset: "[0m",
            dim: chalk.dim,
            bold: chalk.bold,
            white: chalk.white,
            green: chalk.green,
            yellow: chalk.yellow,
            red: chalk.red,
            brightRed: chalk.redBright,
            cyan: chalk.cyan,
          },
        });
        if (result.rendered) {
          if (globalOpts.json && result.input) {
            console.log(formatJson(result.input));
          }
          return;
        }
        // No narrative: the name after the prefix is checked as a package
        // target (no-scan, scan paths).
        pkg = target.fallback;
      } else {
        pkg = target;
      }

      // `pip:` or `npm:` with nothing after it names no package: a usage
      // error, not a lookup of a package called "pip:".
      if (pkg.kind === "invalid") {
        console.error(
          `Error: No package name after "${pkg.prefix}". Usage: ${checkCitation()} ${pkg.prefix}<package>`
        );
        finish("usage-error");
        return;
      }

      // The ecosystem from a pip: / npm: prefix flows through to every
      // not-found / scan-path output site (#50). An MCP shorthand
      // (`server-*` -> `@modelcontextprotocol/server-*`) is noted when expanded.
      if (pkg.kind === "npm" && pkg.shorthand) logResolved(pkg.shorthand, pkg.spec);
      const { spec: name, ecosystem } = pkg;
      const client = createRegistryClient({
        baseUrl: globalOpts.registryUrl,
        userAgent: `ai-trust/${AI_TRUST_VERSION}`,
      });

      // --rescan is deprecated — local scan is now the default
      if (opts.rescan) {
        console.error(chalk.dim("  Note: --rescan is deprecated. Local scan is now the default."));
      }

      // --no-scan: registry lookup only (fast mode)
      if (opts.scan === false) {
        try {
          const result = await client.checkTrust(name, opts.type);
          // The registry can answer a miss with the all-zero package id
          // instead of a 404; the client reads that as found: false. Both are
          // the same miss, with the same output and exit code.
          if (!result.found) throw new PackageNotFoundError(name);
          // Classify using the registry's packageType (authoritative) before
          // falling back to the name-only allowlist.
          const tier = classify({ name, packageType: result.packageType }).tier;
          if (tier === "unrelated") {
            // Registry-confirmed library. Show the trust data alongside an
            // out-of-scope note so the user still sees everything we know.
            printLibraryWithTrust(result, globalOpts.json, ecosystem);
            // Out of scope is informational (exit 0) UNLESS the registry has
            // actually flagged this library as blocked/warning — policy
            // signals always propagate regardless of scope.
            finish(verdictOutcome(result.verdict));
            return;
          }
          if (globalOpts.json) {
            console.log(formatJson(buildCheckJson({ kind: "registry", answer: result, ecosystem })));
          } else {
            console.log(formatCheckResult(result, ecosystem));
          }
          finish(verdictOutcome(result.verdict));
        } catch (err) {
          if (err instanceof PackageNotFoundError) {
            // Registry has no data. The name-only allowlist covers exact
            // matches like "express" or "chalk" that npm's namespace
            // uniqueness makes reliable. For those, show out-of-scope.
            // Otherwise fall through to the standard "not found" handler.
            const nameTier = classify({ name }).tier;
            if (nameTier === "unrelated") {
              printOutOfScopeByName(pkg, globalOpts.json);
              return; // exit 0
            }
            handleNoScanNotFound(pkg, globalOpts);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            if (globalOpts.json) {
              console.log(formatJson(buildNotFoundOutput({
                name,
                ecosystem,
                error: message,
              })));
            } else {
              // A registry error can quote the registry's response body.
              console.error(`Error: ${stripControlCharacters(message)}`);
            }
            finish("error");
          }
        }
        return;
      }

      // Default: scan flow. Before spending time on a download + HMA scan,
      // check the registry. If the registry has classified this package as
      // a library, skip the scan and show the registry answer — scanning
      // chalk with ai-trust produces confusing output.
      //
      // IMPORTANT: we do NOT pre-classify by name alone. A malicious package
      // whose name happens to match our library allowlist (e.g. a squatted
      // @types/* entry the registry hasn't catalogued yet) must still be
      // scanned. Only registry-confirmed libraries skip the scan.
      try {
        const registryResult = await client.checkTrust(name, opts.type);
        const tier = classify({ name, packageType: registryResult.packageType }).tier;
        if (tier === "unrelated") {
          printLibraryWithTrust(registryResult, globalOpts.json, ecosystem);
          // Policy signals propagate even for out-of-scope libraries.
          finish(verdictOutcome(registryResult.verdict));
          return;
        }
        // native / adjacent / unknown — fall through to scan
      } catch (err) {
        if (!(err instanceof PackageNotFoundError)) {
          // Unexpected registry error — don't fail the scan, just log and continue.
          // The user asked for trust info; let the scan produce something useful.
          // A registry error can quote the registry's response body.
          const message = stripControlCharacters(
            err instanceof Error ? err.message : String(err),
          );
          console.error(chalk.dim(`  Registry lookup failed (${message}); proceeding with local scan.`));
        }
        // PackageNotFoundError: registry doesn't know this package — scan it.
        // We deliberately do NOT consult the name allowlist here; a novel
        // package with a library-ish name could just as easily be a typosquat
        // as a legitimate library, and scanning costs nothing beyond latency.
      }

      await handleScanFlow(
        pkg,
        client,
        globalOpts,
        opts,
        `Scanning ${name}...`
      );
    });

  // Self-citations honor AI_TRUST_CLI_PREFIX. When opena2a-cli bundles us it
  // sets AI_TRUST_CLI_PREFIX="opena2a registry", and the `ai-trust check`
  // token pair is replaced wholesale (the `check` verb is absorbed because
  // `opena2a registry` IS the check command). Unset → native `ai-trust check`.
  //
  // Commander auto-generates the usage line from the program name + command
  // name (`ai-trust check [options] <name>`). Override commandUsage so the
  // prefix surfaces there too; when unset, reproduce the native string exactly.
  checkCmd.configureHelp({
    commandUsage(cmd) {
      const args = cmd.usage(); // "[options] <name>"
      return `${checkCitation()} ${args}`;
    },
  });

  // Examples block, routed through the same prefix helper so a prefixed
  // invocation never leaks `ai-trust check` into the help text.
  checkCmd.addHelpText("after", () => {
    const cite = checkCitation();
    return `
Examples:
  ${cite} @modelcontextprotocol/server-filesystem
  ${cite} some-mcp-server --no-scan
  ${cite} unknown-pkg --contribute
  ${cite} some-pkg --json
`;
  });
}

// NOTE: handleNotFound is currently unreferenced (the action handler routes
// directly to handleNoScanNotFound / handleScanFlow). Kept for now in case
// a future interactive-not-found flow wants to consume it; the target
// carries the pip:/npm: ecosystem through if it does.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function handleNotFound(
  target: PackageTarget,
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  const { spec: name, ecosystem } = target;
  // Non-interactive mode with --scan-if-missing
  if (opts.scanIfMissing) {
    await handleScanFlow(
      target,
      client,
      globalOpts,
      opts,
      `Package "${name}" not found in registry. Scanning...`
    );
    return;
  }

  // Non-TTY: report not found with actionable next steps
  if (!process.stdin.isTTY) {
    if (globalOpts.json) {
      console.log(formatJson(buildNotFoundOutput({
        name,
        ecosystem,
        error: `Package "${name}" not found in the OpenA2A Registry.`,
        nextSteps: [
          `${checkCitation()} ${name} --scan-if-missing`,
          `npx hackmyagent secure <project-dir>`,
        ],
      })));
    } else {
      console.error(`Package "${name}" not found in the OpenA2A Registry.\n`);
      console.error("  Scan it locally:");
      console.error(`    ${checkCitation()} ${name} --scan-if-missing`);
      console.error("");
      console.error("  Or scan your full project:");
      console.error("    npx hackmyagent secure .");
    }
    finish("not-found");
    return;
  }

  // Interactive mode: ask the user
  console.error(
    chalk.gray(`Package "${name}" not found in the OpenA2A Registry.`)
  );

  if (!(await checkHmaReady())) return;

  const shouldScan = await confirm("No trust data yet. Scan it now?", true);
  if (!shouldScan) {
    finish("not-found");
    return;
  }

  await handleScanFlow(target, client, globalOpts, opts, "Scanning...");
}

/** The downloader's refusal of a name that is not an npm registry package name. */
const NPM_NAME_REFUSAL = /is not a valid npm package name/;

/**
 * The not-found hint for a failed download, or undefined when the failure
 * is not one translateDownloadError recognizes. The npm downloader refuses a
 * name that is not an npm registry package name before `npm pack` runs, so a
 * git-style `<owner>/<repo>` no longer reaches npm's git fallback and its
 * `code 128`. That refusal gets the not-found block, with the
 * `@<owner>/<repo>` suggestion, that translateDownloadError gives for that
 * `code 128`, so `check <owner>/<repo>` keeps its released result and exit
 * code 2.
 */
function downloadMiss(
  target: PackageTarget,
  message: string
): ReturnType<typeof translateDownloadError> {
  const translated = translateDownloadError(target.spec, message);
  if (translated !== undefined) return translated;
  if (target.kind === "git" && NPM_NAME_REFUSAL.test(message)) {
    return translateDownloadError(target.spec, "code 128");
  }
  return undefined;
}

async function handleScanFlow(
  target: PackageTarget,
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions,
  statusMessage: string
): Promise<void> {
  const { spec: name, ecosystem } = target;
  if (!(await checkHmaReady())) return;

  console.error(chalk.gray(statusMessage));

  let scanResult: ScanResult;
  try {
    scanResult = await scanPackage(name, { deep: opts.deep ?? true, analm: opts.analm, ecosystem });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Translate recognized downloader errors into a not-found block so users
    // see the same UX they get for a clean registry miss instead of a raw
    // `code 128` git exit code (F3 from the check-command-divergence brief).
    const translated = downloadMiss(target, message);
    if (translated !== undefined) {
      if (globalOpts.json) {
        console.log(formatJson(buildNotFoundOutput({
          name,
          ecosystem,
          error: message,
          errorHint: translated.errorHint,
          suggestions: translated.suggestions,
        })));
      } else {
        console.log(
          formatNotFound({
            pkg: name,
            ecosystem,
            errorHint: translated.errorHint,
            suggestions: translated.suggestions,
          })
        );
      }
      finish("not-found");
      return;
    }
    if (globalOpts.json) {
      console.log(formatJson(buildNotFoundOutput({
        name,
        ecosystem,
        error: message,
      })));
    } else {
      console.error(`Error: ${message}`);
    }
    finish("error");
    return;
  }

  // Output scan results. This path scanned a downloaded package (npm pack /
  // PyPI archive), not the user's own tree → remote verdict (no `secure --fix`).
  if (globalOpts.json) {
    console.log(formatJson(buildCheckJson({ kind: "scan", scan: scanResult, ecosystem })));
  } else {
    console.log(formatScanResult(scanResult, { remote: true, ecosystem }));
  }

  // Set exit code based on verdict (2 = policy signal, matching audit/batch)
  finish(verdictOutcome(scanResult.verdict));

  // The scan ping and the community contribution: whether to share is
  // decided by decideContribution, with the same inputs as `audit`.
  await shareScans("check", [{ name, scanResult }], {
    flag: opts.contribute,
    registryUrl: globalOpts.registryUrl,
    ecosystem,
    type: opts.type,
  });
}

function handleNoScanNotFound(
  target: PackageTarget,
  globalOpts: { registryUrl: string; json: boolean }
): void {
  const { spec: name, ecosystem } = target;
  if (globalOpts.json) {
    console.log(formatJson(buildNotFoundOutput({
      name,
      ecosystem,
      error: `Package "${name}" not found in the OpenA2A Registry.`,
      nextSteps: [
        // Without --no-scan, check downloads and scans the package.
        `${checkCitation()} ${name}`,
        `npx hackmyagent secure <project-dir>`,
      ],
    })));
  } else {
    // Shared cli-ui renderNotFoundBlock output (F2 from the check-command-divergence brief).
    console.log(formatNotFound({ pkg: name, ecosystem }));
  }
  finish("not-found");
}

async function checkHmaReady(): Promise<boolean> {
  const available = await isHmaAvailable();
  if (!available) {
    console.error(
      "HMA (HackMyAgent) is required for scanning. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:"
    );
    console.error(`  ${reinstallCommand()}`);
    finish("error");
    return false;
  }
  return true;
}

/** How a check ended, and the exit code of each outcome. */
const EXIT_CODES = {
  // An answer or scan with no policy signal.
  ok: 0,
  // The registry or the scan says blocked or warning.
  "policy-signal": 2,
  // No registry data with --no-scan, or no package to download.
  "not-found": 2,
  // The target names no package.
  "usage-error": 1,
  // The registry lookup or the download failed, or the scanner cannot run.
  error: 1,
} as const;
type CheckOutcome = keyof typeof EXIT_CODES;

/** Set the exit code for an outcome. 0 leaves the exit code as it is. */
function finish(outcome: CheckOutcome): void {
  const code = EXIT_CODES[outcome];
  if (code !== 0) process.exitCode = code;
}

/**
 * The outcome of a registry or scan verdict: a policy signal for blocked or
 * warning. A registry-flagged blocked/warning library should still fail CI
 * even though the package itself is out of ai-trust's scope.
 */
function verdictOutcome(verdict?: string): CheckOutcome {
  const policyFailure =
    verdict === "blocked" ||
    verdict === "warning" ||
    verdict === "warnings" ||
    verdict === "failed";
  return policyFailure ? "policy-signal" : "ok";
}

/**
 * Print a registry-confirmed library result. Per the v0.3 spec
 * (ai-trust/CLAUDE.md "UX philosophy v0.3"), Tier 3 libraries get
 * ONLY the out-of-scope notice + HMA CTA \u2014 no trust block. Rendering
 * the trust block on top would surface a misleading "Scan failed \u2014
 * score is unreliable" line on errored library scans (AI-TRUST-1).
 * The full trust read for libraries lives in `hackmyagent check`.
 */
function printLibraryWithTrust(
  result: TrustAnswer,
  asJson: boolean,
  ecosystem: "npm" | "pypi",
): void {
  if (asJson) {
    // Out-of-scope JSON must AGREE with the human output, which shows no trust
    // block for libraries (v0.3 spec). Previously this spread `...result`, so
    // the top level carried `trustScore` / `trustLevel` / `verdict` — a script
    // reading those used them as an ai-trust verdict even though ai-trust does
    // not score general-purpose libraries. Lead with scope, mark `scored:
    // false`, and nest the registry's raw data under `registryData` (preserved
    // for reference, but explicitly not an ai-trust verdict). Release-test P2.
    console.log(formatJson({
      name: result.name,
      ecosystem,
      packageType: result.packageType,
      found: result.found,
      outOfScope: true,
      scored: false,
      outOfScopeReason: "registry-classified as general-purpose library",
      nextSteps: [`hackmyagent check ${hmaCheckTarget(result.name, ecosystem)}`],
      registryData: result,
    }));
    return;
  }
  // The name is the registry's string: control characters are removed first.
  const name = stripControlCharacters(result.name);
  console.error("");
  console.error(
    `  ${chalk.bold.white(name)}${ecosystemSuffix(ecosystem)}  ${chalk.dim("library (registry-classified)")}`
  );
  console.error(
    `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 the registry classifies this as a general-purpose library.")}`
  );
  console.error(`  ${chalk.dim("For a thorough security audit:")}`);
  console.error(`    ${chalk.cyan(`hackmyagent check ${hmaCheckTarget(name, ecosystem)}`)}`);
  console.error("");
}

/**
 * The target to hand `hackmyagent check`. Its help gives the bare name as the
 * npm form (`hackmyagent check express`) and `pip:<name>` as the PyPI form
 * (`hackmyagent check pip:requests`), so a PyPI package keeps the prefix.
 * The name can come from the registry, so it is quoted for the shell.
 */
function hmaCheckTarget(name: string, ecosystem: "npm" | "pypi"): string {
  return shellArg(ecosystem === "pypi" ? `pip:${name}` : name);
}

/**
 * Print an out-of-scope notice for a package the registry doesn't know about
 * but whose name matches our library allowlist. Explicitly notes the lack of
 * registry confirmation so the user knows we haven't verified anything.
 */
function printOutOfScopeByName(target: PackageTarget, asJson: boolean): void {
  const { spec: name, ecosystem } = target;
  if (asJson) {
    console.log(formatJson({
      name,
      ecosystem,
      found: false,
      outOfScope: true,
      scored: false,
      outOfScopeReason: "recognized as general-purpose library by name (no registry data)",
      nextSteps: [`hackmyagent check ${hmaCheckTarget(name, ecosystem)}`],
    }));
  } else {
    console.error("");
    console.error(
      `  ${chalk.bold.white(name)}${ecosystemSuffix(ecosystem)}  ${chalk.dim("library (by name — no registry data)")}`
    );
    console.error(
      `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).")}`
    );
    console.error("");
    console.error(`  For general security scanning, use HackMyAgent:`);
    console.error(`    ${chalk.cyan(`hackmyagent check ${hmaCheckTarget(name, ecosystem)}`)}`);
    console.error("");
  }
}
