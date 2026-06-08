/**
 * ai-trust check - Single package trust lookup with scan-on-demand.
 *
 * When a package isn't in the registry, offers to scan it locally with HMA
 * and optionally contribute results to the community registry.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { classify } from "@opena2a/ai-classifier";
import { RegistryClient, PackageNotFoundError, firstPartySignerFromEnv } from "@opena2a/registry-client";
import type { TrustAnswer } from "@opena2a/registry-client";
import {
  formatCheckResult,
  formatScanResult,
  formatJson,
  formatNotFound,
} from "../output/formatter.js";
import { buildNotFoundOutput, translateDownloadError } from "@opena2a/check-core";
import { resolveAndLog, parsePackageTarget } from "../utils/resolve.js";
import { isHmaAvailable, scanPackage, scanLocalPath } from "../scanner/index.js";
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
            chalk.red("error: HMA is not available. Install hackmyagent or ensure node_modules/.bin/hackmyagent resolves."),
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
        const richClient = new RegistryClient({
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
            console.log(JSON.stringify(result.input, null, 2));
          }
          return;
        }
        // No narrative → falls through; classifier picks up parsed.name
        // as a normal lookup target. Replace the name so downstream
        // logic (no-scan, scan paths) operates on the unprefixed name.
        rawName = parsed.name;
      }

      // Strip ecosystem prefix (pip: / npm:) before MCP-shorthand resolution.
      // Closes #50: prior to this, `check pip:<pkg>` kept the prefix in the
      // output `name` and reported `ecosystem: "npm"`. Now ecosystem flows
      // through to every not-found / scan-path output site.
      const { name: stripped, ecosystem } = parsePackageTarget(rawName);
      rawName = stripped;

      const name = resolveAndLog(rawName);
      const client = new RegistryClient({
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
            printLibraryWithTrust(result, globalOpts.json);
            // Out of scope is informational (exit 0) UNLESS the registry has
            // actually flagged this library as blocked/warning — policy
            // signals always propagate regardless of scope.
            if (isPolicyFailure(result.verdict)) {
              process.exitCode = 2;
            }
            return;
          }
          if (globalOpts.json) {
            console.log(formatJson(buildCheckJson({ kind: "registry", answer: result })));
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
            // Registry has no data. The name-only allowlist covers exact
            // matches like "express" or "chalk" that npm's namespace
            // uniqueness makes reliable. For those, show out-of-scope.
            // Otherwise fall through to the standard "not found" handler.
            const nameTier = classify({ name }).tier;
            if (nameTier === "unrelated") {
              printOutOfScopeByName(name, globalOpts.json);
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
              console.error(`Error: ${message}`);
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
          printLibraryWithTrust(registryResult, globalOpts.json);
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
          const message = err instanceof Error ? err.message : String(err);
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
  ${cite} unknown-pkg --scan-if-missing
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
    scanResult = await scanPackage(name, { deep: opts.deep ?? true, analm: opts.analm });
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

  // Output scan results. This path scanned a downloaded package (npm-pack /
  // pip-download), not the user's own tree → remote verdict (no `secure --fix`).
  if (globalOpts.json) {
    console.log(formatJson(buildCheckJson({ kind: "scan", scan: scanResult })));
  } else {
    console.log(formatScanResult(scanResult, { remote: true }));
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
            `    ${checkCitation()} ${name} --scan-if-missing --contribute`
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
    const client = new RegistryClient({
      baseUrl: registryUrl,
      userAgent: `ai-trust/${AI_TRUST_VERSION}`,
    });
    // ai-trust is NOT first_party_scanner; self-tag source=ci only when run in our CI
    // (AI_TRUST_CI_SIGNING_KEY set). End-user `check` runs publish as community.
    const signer = firstPartySignerFromEnv({
      keyEnv: "AI_TRUST_CI_SIGNING_KEY",
      source: "ci",
    });
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
    }, signer);
    if (resp.publishId) {
      console.error(chalk.dim(`  Published to registry (${resp.publishId.slice(0, 8)})`));
    }
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
        `${checkCitation()} ${name} --scan-if-missing`,
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
      "HMA (HackMyAgent) is required for scanning. Install it with:"
    );
    console.error("  npm install -g hackmyagent");
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
function printLibraryWithTrust(result: TrustAnswer, asJson: boolean): void {
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
      packageType: result.packageType,
      found: result.found,
      outOfScope: true,
      scored: false,
      outOfScopeReason: "registry-classified as general-purpose library",
      nextSteps: [`hackmyagent check ${result.name}`],
      registryData: result,
    }));
    return;
  }
  console.error("");
  console.error(
    `  ${chalk.bold.white(result.name)}  ${chalk.dim("library (registry-classified)")}`
  );
  console.error(
    `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 the registry classifies this as a general-purpose library.")}`
  );
  console.error(`  ${chalk.dim("For a thorough security audit:")}`);
  console.error(`    ${chalk.cyan(`hackmyagent check ${result.name}`)}`);
  console.error("");
}

/**
 * Print an out-of-scope notice for a package the registry doesn't know about
 * but whose name matches our library allowlist. Explicitly notes the lack of
 * registry confirmation so the user knows we haven't verified anything.
 */
function printOutOfScopeByName(name: string, asJson: boolean): void {
  if (asJson) {
    console.log(formatJson({
      name,
      found: false,
      outOfScope: true,
      scored: false,
      outOfScopeReason: "recognized as general-purpose library by name (no registry data)",
      nextSteps: [`hackmyagent check ${name}`],
    }));
  } else {
    console.error("");
    console.error(
      `  ${chalk.bold.white(name)}  ${chalk.dim("library (by name — no registry data)")}`
    );
    console.error(
      `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).")}`
    );
    console.error("");
    console.error(`  For general security scanning, use HackMyAgent:`);
    console.error(`    ${chalk.cyan(`hackmyagent check ${name}`)}`);
    console.error("");
  }
}
