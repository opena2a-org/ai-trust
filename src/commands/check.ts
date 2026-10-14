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
import { PackageNotFoundError, firstPartySignerFromEnv } from "@opena2a/registry-client";
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
import { resolveAndLog, parsePackageTarget, bareEcosystemPrefix } from "../utils/resolve.js";
import { stripControlCharacters } from "../output/sanitize.js";
import { isHmaAvailable, reinstallCommand, scanPackage, scanLocalPath } from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import {
  resolveContributeChoice,
  queueScanResult,
  flushQueue,
  recordScanAndMaybeShowTip,
  saveContributeChoice,
  sendScanPing,
} from "../telemetry/index.js";
import { buildScanSubmission } from "../telemetry/publish.js";
import { checkSkillOrMcp, parseRichTarget } from "../check/skill-mcp-check.js";
import { checkCitation } from "../utils/cli-prefix.js";
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
  /** Internal: set when scanning a package not yet in the registry */
  _firstScan?: boolean;
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

      // Rich-block dispatch (skill: / mcp: prefix). Mirrors HMA's
      // src/check/ module for parity F12 / F13. When the registry
      // has a fresh narrative, render the rich block and exit.
      // Otherwise fall through to the existing classifier flow.
      const parsed = parseRichTarget(rawName);
      if (parsed) {
        const richClient = createRegistryClient({
          baseUrl: globalOpts.registryUrl,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        });
        const result = await checkSkillOrMcp({
          parsed,
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
        // No narrative → falls through; classifier picks up parsed.name
        // as a normal lookup target. Replace the name so downstream
        // logic (no-scan, scan paths) operates on the unprefixed name.
        rawName = parsed.name;
      }

      // `pip:` or `npm:` with nothing after it names no package: a usage
      // error, not a lookup of a package called "pip:".
      const barePrefix = bareEcosystemPrefix(rawName);
      if (barePrefix) {
        console.error(
          `Error: No package name after "${barePrefix}". Usage: ${checkCitation()} ${barePrefix}<package>`
        );
        process.exitCode = 1;
        return;
      }

      // Strip ecosystem prefix (pip: / npm:) before MCP-shorthand resolution.
      // Closes #50: prior to this, `check pip:<pkg>` kept the prefix in the
      // output `name` and reported `ecosystem: "npm"`. Now ecosystem flows
      // through to every not-found / scan-path output site.
      const { name: stripped, ecosystem } = parsePackageTarget(rawName);
      rawName = stripped;

      // MCP shorthand (`server-*` -> `@modelcontextprotocol/server-*`) names
      // npm packages; a pip: target is used as given.
      const name = ecosystem === "npm" ? resolveAndLog(rawName) : rawName;
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
            if (isPolicyFailure(result.verdict)) {
              process.exitCode = 2;
            }
            return;
          }
          if (globalOpts.json) {
            console.log(formatJson(buildCheckJson({ kind: "registry", answer: result, ecosystem })));
          } else {
            console.log(formatCheckResult(result, ecosystem));
          }
          if (
            result.found &&
            (result.verdict === "blocked" || result.verdict === "warning" || result.verdict === "warnings" || result.verdict === "failed")
          ) {
            process.exitCode = 2;
          }
        } catch (err) {
          if (err instanceof PackageNotFoundError) {
            // Registry has no data. The name-only allowlist covers exact
            // matches like "express" or "chalk" that npm's namespace
            // uniqueness makes reliable. For those, show out-of-scope.
            // Otherwise fall through to the standard "not found" handler.
            const nameTier = classify({ name }).tier;
            if (nameTier === "unrelated") {
              printOutOfScopeByName(name, globalOpts.json, ecosystem);
              return; // exit 0
            }
            handleNoScanNotFound(name, ecosystem, globalOpts);
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
            process.exitCode = 1;
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
          if (isPolicyFailure(registryResult.verdict)) {
            process.exitCode = 2;
          }
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
        name,
        ecosystem,
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
// a future interactive-not-found flow wants to consume it; the ecosystem
// param threads pip:/npm: prefix awareness through if it does.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function handleNotFound(
  name: string,
  ecosystem: "npm" | "pypi",
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  // Non-interactive mode with --scan-if-missing
  if (opts.scanIfMissing) {
    await handleScanFlow(
      name,
      ecosystem,
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

  await handleScanFlow(name, ecosystem, client, globalOpts, { ...opts, _firstScan: true }, "Scanning...");
}

async function handleScanFlow(
  name: string,
  ecosystem: "npm" | "pypi",
  client: RegistryClient,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions,
  statusMessage: string
): Promise<void> {
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
    const translated = translateDownloadError(name, message);
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
      process.exitCode = 2;
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
    process.exitCode = 1;
    return;
  }

  // Output scan results. This path scanned a downloaded package (npm pack /
  // PyPI archive), not the user's own tree → remote verdict (no `secure --fix`).
  if (globalOpts.json) {
    console.log(formatJson(buildCheckJson({ kind: "scan", scan: scanResult, ecosystem })));
  } else {
    console.log(formatScanResult(scanResult, { remote: true }));
  }

  // Set exit code based on verdict (2 = policy signal, matching audit/batch)
  if (scanResult.verdict === "blocked" || scanResult.verdict === "warning") {
    process.exitCode = 2;
  }

  // Anonymous scan ping. Shares the SAME contribution consent as the full
  // contribution flow below -- package name + verdict is scan-result data,
  // not invocation telemetry, so --no-contribute must be able to stop it.
  if (resolveContributeChoice(opts.contribute)) {
    sendScanPing(
      name,
      scanResult.verdict,
      Math.round(scanResult.trustScore * 100),
      globalOpts.registryUrl,
      ecosystem
    );
  }

  // Community contribution flow
  await handleContribute(name, ecosystem, scanResult, globalOpts, opts);
}

let _shownCiContributeTip = false;

async function handleContribute(
  name: string,
  ecosystem: "npm" | "pypi",
  scanResult: ScanResult,
  globalOpts: { registryUrl: string; json: boolean },
  opts: CheckOptions
): Promise<void> {
  const alreadyEnabled = resolveContributeChoice(opts.contribute);

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
          chalk.gray("  (Future scans will auto-share. Change: ai-trust config contribute off)")
        );
        await submitContribution(name, ecosystem, scanResult, globalOpts.registryUrl, { type: opts.type });
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
        const target = ecosystem === "pypi" ? `pip:${name}` : name;
        console.error(
          chalk.cyan(
            `    ${checkCitation()} ${target} --scan-if-missing --contribute`
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

  await submitContribution(name, ecosystem, scanResult, globalOpts.registryUrl, { type: opts.type });
}

async function submitContribution(
  name: string,
  ecosystem: "npm" | "pypi",
  scanResult: ScanResult,
  registryUrl: string,
  opts?: { type?: string }
): Promise<void> {
  // Contribution is silent once consent is given: no per-scan line. Disclosure
  // lives in the consent prompt, `--help`, and `config contribute status`.
  try {
    queueScanResult(name, scanResult.scan.findings, 0, ecosystem, scanResult.packageVersion);
    await flushQueue(registryUrl);
  } catch {
    // Non-fatal: contribution should never crash the scan
  }

  // Publish per-check results via unified endpoint for evidence correlation + consensus
  try {
    const client = createRegistryClient({
      baseUrl: registryUrl,
      userAgent: `ai-trust/${AI_TRUST_VERSION}`,
    });
    // ai-trust is NOT first_party_scanner; self-tag source=ci only when run in our CI
    // (AI_TRUST_CI_SIGNING_KEY set). End-user `check` runs publish as community.
    const signer = firstPartySignerFromEnv({
      keyEnv: "AI_TRUST_CI_SIGNING_KEY",
      source: "ci",
    });
    await client.publishScan(
      buildScanSubmission(name, scanResult, { toolVersion: AI_TRUST_VERSION, type: opts?.type, ecosystem }),
      signer,
    );
  } catch {
    // Non-fatal: contribution should never crash the scan
  }
}

function handleNoScanNotFound(
  name: string,
  ecosystem: "npm" | "pypi",
  globalOpts: { registryUrl: string; json: boolean }
): void {
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
  process.exitCode = 2;
}

async function checkHmaReady(): Promise<boolean> {
  const available = await isHmaAvailable();
  if (!available) {
    console.error(
      "HMA (HackMyAgent) is required for scanning. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:"
    );
    console.error(`  ${reinstallCommand()}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * True when a registry verdict represents a policy failure worth surfacing
 * via exit code 2. A registry-flagged blocked/warning library should still
 * fail CI even though the package itself is out of ai-trust's scope.
 */
function isPolicyFailure(verdict?: string): boolean {
  return (
    verdict === "blocked" ||
    verdict === "warning" ||
    verdict === "warnings" ||
    verdict === "failed"
  );
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
 */
function hmaCheckTarget(name: string, ecosystem: "npm" | "pypi"): string {
  return ecosystem === "pypi" ? `pip:${name}` : name;
}

/**
 * Print an out-of-scope notice for a package the registry doesn't know about
 * but whose name matches our library allowlist. Explicitly notes the lack of
 * registry confirmation so the user knows we haven't verified anything.
 */
function printOutOfScopeByName(
  name: string,
  asJson: boolean,
  ecosystem: "npm" | "pypi",
): void {
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
