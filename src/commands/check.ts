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
import {
  createRegistryClient,
  registryErrorMessage,
  registryFailureSentence,
} from "../utils/registry-client.js";
import {
  ecosystemSuffix,
  formatCheckResult,
  formatScanResult,
  formatJson,
  formatNotFound,
  showsRegistryScore,
} from "../output/formatter.js";
import type { FormatScanResultOptions } from "../output/formatter.js";
import { buildNotFoundOutput, translateDownloadError } from "@opena2a/check-core";
import { logResolved } from "../utils/resolve.js";
import {
  redactUrlUserinfo,
  stripControlCharacters,
  urlWithoutUserinfo,
} from "../output/sanitize.js";
import { analystLayerNote } from "../output/analyst-note.js";
import {
  HmaScanError,
  isHmaAvailable,
  reinstallCommand,
  scanPackage,
  scanLocalPath,
  scannerNodeVersionProblem,
  scannerTempDirProblem,
  ScanPathError,
} from "../scanner/index.js";
import type { ScanResult } from "../scanner/index.js";
import { nothingToScan } from "../scanner/hma.js";
import type { HmaFinding } from "../scanner/hma.js";
import { findingPath } from "../output/finding-location.js";
import { confirm } from "../utils/prompt.js";
import { shareScans } from "../telemetry/index.js";
import { checkSkillOrMcp } from "../check/skill-mcp-check.js";
import { classifyCheckTarget, targetArgument } from "../check/target.js";
import type { InvalidTarget, PackageTarget, RichTarget } from "../check/target.js";
import { checkCitation } from "../utils/cli-prefix.js";
import { packageTypeChoices, packageTypeProblem } from "../utils/package-type.js";
import { shellArg } from "../utils/shell-arg.js";
import { buildCheckJson } from "../output/check-json.js";
import { lstatSync } from "node:fs";
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
  /** Print every finding in text output, not the first ten (--all). */
  all?: boolean;
}

/**
 * The `file` values of the failed findings that name nothing in the scanned
 * directory. A scanner advisory about a missing file gives, as its `file`,
 * the path its fix would create (DEP-001 names package-lock.json,
 * SANDBOX-001 a Dockerfile), so each path is looked up, once per file,
 * rather than inferred from the check id. A path that could not be looked up
 * for another reason, such as permission denied, is not reported absent.
 */
function absentFindingFiles(scanPath: string, findings: HmaFinding[]): Set<string> {
  const looked = new Set<string>();
  const absent = new Set<string>();
  for (const f of findings) {
    if (f.passed || typeof f.file !== "string" || f.file === "" || looked.has(f.file)) continue;
    looked.add(f.file);
    try {
      lstatSync(findingPath(scanPath, f.file));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") absent.add(f.file);
    }
  }
  return absent;
}

/**
 * The `check` command that printed a scan result, without `--all`, for the
 * line that counts the findings text output did not print. It carries the
 * name and the options that change what is scanned or where the result is
 * sent; `--json` is left out because the line is printed in text output only.
 */
function rerunCommand(
  rawName: string,
  opts: CheckOptions,
  registryUrlFromCli: string | undefined,
): string {
  const parts = [checkCitation(), shellArg(rawName)];
  if (opts.scanPath) parts.push("--scan-path", shellArg(opts.scanPath));
  if (opts.type) parts.push("--type", shellArg(opts.type));
  if (opts.deep === false) parts.push("--no-deep");
  if (opts.analm) parts.push("--analm");
  if (opts.contribute === true) parts.push("--contribute");
  if (opts.contribute === false) parts.push("--no-contribute");
  if (registryUrlFromCli) {
    parts.push("--registry-url", shellArg(urlWithoutUserinfo(registryUrlFromCli)));
  }
  return parts.join(" ");
}

export function registerCheckCommand(program: Command): void {
  const checkCmd = program
    .command("check <name>")
    .description("Download and scan a single package, then report its trust verdict")
    .option(
      "-t, --type <type>",
      `package type filter (${packageTypeChoices()})`
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
      "also run the scanner's analyst layer, which needs a NanoMind analyst daemon on this machine (npx hackmyagent nanomind setup); a note on stderr after the result says whether it ran"
    )
    .option(
      "--scan-path <dir>",
      "scan a local directory instead of downloading a package; <name> labels the result"
    )
    .option(
      "--all",
      "print every finding with its fix (text output prints the first 10 by default)"
    )
    .action(async (rawName: string, opts: CheckOptions) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      // A --type that is not one of the package types is a usage error,
      // before any lookup, download or scan.
      const typeProblem = packageTypeProblem(opts.type);
      if (typeProblem !== undefined) {
        usageError(typeProblem, globalOpts.json);
        return;
      }

      const textOpts = {
        all: opts.all === true,
        rerunCommand: rerunCommand(
          rawName,
          opts,
          program.getOptionValueSource("registryUrl") === "cli"
            ? globalOpts.registryUrl
            : undefined,
        ),
      };

      // The deprecated flags are accepted and change nothing; each says so.
      if (opts.scanIfMissing) {
        console.error(chalk.dim("  Note: --scan-if-missing is deprecated. Every package is scanned by default."));
      }
      if (opts.rescan) {
        console.error(chalk.dim("  Note: --rescan is deprecated. Local scan is now the default."));
      }

      // --scan-path: scan a local directory directly. No registry lookup, no
      // download step, no contribution. Used for adversarial-corpus fixtures
      // and any on-disk target. The <name> argument is treated as a label
      // for the result (typically the fixture path).
      if (opts.scanPath) {
        // Flags this path does not act on are named, not dropped silently.
        if (opts.scan === false) {
          console.error(
            chalk.dim("  Note: --no-scan is ignored with --scan-path: the directory is scanned, and the registry is not asked."),
          );
        }
        if (opts.contribute === true) {
          console.error(
            chalk.dim("  Note: --contribute is ignored with --scan-path: a directory scan is not shared with the registry."),
          );
        }
        if (!(await isHmaAvailable())) {
          const startProblem = scannerNodeVersionProblem() ?? scannerTempDirProblem();
          const msg = startProblem
            ? `HMA could not be started. ${startProblem}`
            : `HMA is not available. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it: ${reinstallCommand()}`;
          // With --json the error is one object on stdout, the object
          // printed below for a scan that fails.
          if (globalOpts.json) {
            console.log(formatJson(buildNotFoundOutput({ name: rawName, error: msg })));
          } else {
            console.error(chalk.red(`error: ${msg}`));
          }
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
          // The exit code is set and the handler returns, as handleScanFlow
          // does, so the process exits once stdout and stderr have drained.
          // A write to a pipe is asynchronous on macOS, and process.exit(2)
          // right after the print ended the process with an error larger
          // than the pipe buffer cut off (#234).
          // With --json the error is one object on stdout: the object
          // handleScanFlow prints for a scan that fails, without an
          // ecosystem, since --scan-path scans a directory, not a package.
          if (globalOpts.json) {
            console.log(formatJson(buildNotFoundOutput({ name: rawName, error: msg })));
            finish("scan-not-run");
            return;
          }
          console.error(chalk.red(`error: ${msg}`));
          // The directory hint is for a directory scanLocalPath refused. The
          // scanner can also fail on a directory that exists and is readable.
          // Another error, such as a temporary home for the scanner that
          // could not be created, prints alone: its message names its fix.
          if (e instanceof ScanPathError) {
            console.error(
              chalk.dim(
                "Fix: pass --scan-path to a directory that exists and is readable.",
              ),
            );
          } else if (e instanceof HmaScanError) {
            console.error(
              chalk.dim(
                `Fix: the scanner produced no readable report. Run it directly: npx hackmyagent secure ${shellArg(opts.scanPath)}`,
              ),
            );
            console.error(
              chalk.dim(`Or reinstall the hackmyagent copy ai-trust runs: ${reinstallCommand()}`),
            );
          }
          finish("scan-not-run");
          return;
        }
        // Override packageName with the user-supplied name so output is
        // labeled clearly when the same fixture is invoked under different
        // names (e.g. release-smoke harness uses surface/intent/fixture).
        result.packageName = rawName;
        const absentFiles = absentFindingFiles(opts.scanPath, result.scan.findings);
        if (globalOpts.json) {
          console.log(
            formatJson(
              buildCheckJson({ kind: "scan", scan: result, scanPath: opts.scanPath, absentFiles }),
            ),
          );
        } else {
          // --scan-path scans the user's own on-disk tree → local verdict.
          console.log(
            formatScanResult(result, {
              remote: false,
              scanPath: opts.scanPath,
              absentFiles,
              ...textOpts,
            })
          );
        }
        // A scan that read 0 files and found none it could not read measured
        // nothing, which is not a pass.
        if (nothingToScan(result.scan)) finish("not-measured");
        if (opts.analm) noteAnalystLayer(result.scan.analystLayer);
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
        const narrative = narrativeLookup(target);
        const result = await checkSkillOrMcp({
          parsed: { artifactType: target.kind, name: narrative.name },
          version: narrative.version,
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

      // An empty target, or `pip:`, `npm:`, `skill:` or `mcp:` with nothing
      // after it, names no package: a usage error, not a lookup of a package
      // called "" or "pip:". With --json the message is the `error` of one
      // object on stdout, as for a --registry-url usage error.
      if (pkg.kind === "invalid") {
        usageError(invalidTargetProblem(pkg), globalOpts.json);
        return;
      }

      // The ecosystem from a pip: / npm: prefix flows through to every
      // not-found / scan-path output site (#50). An MCP shorthand
      // (`server-*` -> `@modelcontextprotocol/server-*`) is noted when expanded.
      if (pkg.kind === "npm" && pkg.shorthand) logResolved(pkg.shorthand, pkg.spec);
      const { spec: name, ecosystem } = pkg;
      // A pip: target's registry lookup, and the exit code it sets, are for
      // the PyPI package (#131). An npm target is looked up by name alone,
      // as `audit` sends the entries of a package.json.
      const client = createRegistryClient({
        baseUrl: globalOpts.registryUrl,
        userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        ...(ecosystem === "pypi" ? { ecosystem } : {}),
      });

      // --no-scan: registry lookup only (fast mode)
      if (opts.scan === false) {
        if (opts.analm) noteAnalystLayer("no-scan");
        try {
          // The registry looks a package up by its name: a `<name>@<version>`
          // target is looked up as `<name>`.
          let result = await findInRegistry(client, pkg.name, opts.type);
          // The registry keeps some PyPI packages under their bare name only
          // and answers the query with ecosystem=pypi for them as a miss.
          // When it has no PyPI package by the name, a pip: target gets its
          // answer for the name with no ecosystem, the query `check <name>`
          // sends.
          const byBareName = result === undefined && ecosystem === "pypi";
          if (byBareName) {
            const bareNameClient = createRegistryClient({
              baseUrl: globalOpts.registryUrl,
              userAgent: `ai-trust/${AI_TRUST_VERSION}`,
            });
            result = await findInRegistry(bareNameClient, pkg.name, opts.type);
          }
          if (result === undefined) throw new PackageNotFoundError(name);
          if (byBareName) noteBareNameAnswer(pkg);
          notePackageAnswer(pkg);
          // Classify using the registry's packageType (authoritative) before
          // falling back to the name-only allowlist, which is consulted with
          // the package name, as the registry was asked.
          const tier = classify({ name: pkg.name, packageType: result.packageType }).tier;
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
          // A `<name>@<version>` target keeps its version in the JSON, which
          // marks the answer as the package's, and in the Next Steps scan.
          const version = targetVersion(pkg);
          if (globalOpts.json) {
            console.log(
              formatJson(
                buildCheckJson({ kind: "registry", answer: result, ecosystem, requestedVersion: version }),
              ),
            );
          } else {
            console.log(formatCheckResult(result, ecosystem, { version }));
          }
          finish(verdictOutcome(result.verdict));
        } catch (err) {
          if (err instanceof PackageNotFoundError) {
            // Registry has no data. The name-only allowlist covers exact
            // matches like "express" or "chalk" that npm's namespace
            // uniqueness makes reliable. For those, show out-of-scope.
            // Otherwise fall through to the standard "not found" handler.
            // It is consulted with the package name, so `express@4.18.0`
            // matches as `express` does.
            const nameTier = classify({ name: pkg.name }).tier;
            if (nameTier === "unrelated") {
              printOutOfScopeByName(pkg, globalOpts.json);
              return; // exit 0
            }
            handleNoScanNotFound(pkg, globalOpts, opts.type);
          } else {
            const message = registryErrorMessage(err);
            // A registry error can quote the request URL, and the URL's user
            // name and password with it.
            if (globalOpts.json) {
              // The lookup failed, so whether the registry has the package is
              // not known: the object carries no `found`, since `found: false`
              // would read as a miss.
              console.log(formatJson({ name, ecosystem, error: redactUrlUserinfo(message) }));
            } else {
              // A registry error can quote the registry's response body.
              console.error(`Error: ${redactUrlUserinfo(stripControlCharacters(message))}`);
              const failure = registryFailureSentence(err, globalOpts.registryUrl);
              if (failure) {
                console.error(`  ${failure}`);
                // Without --no-scan, check scans the package when the
                // registry lookup fails.
                console.error(`  Next: ${checkCitation()} ${shellArg(targetArgument(pkg))}`);
              }
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
      // The registry's answer for a package it has is kept for the scan
      // output, which prints its score beside this scan's when they differ.
      let registryAnswer: TrustAnswer | undefined;
      let registryError: string | undefined;
      try {
        const registryResult = await client.checkTrust(pkg.name, opts.type);
        const tier = classify({ name, packageType: registryResult.packageType }).tier;
        if (tier === "unrelated") {
          notePackageAnswer(pkg);
          printLibraryWithTrust(registryResult, globalOpts.json, ecosystem);
          if (opts.analm) noteAnalystLayer("registry-library");
          // Policy signals propagate even for out-of-scope libraries.
          finish(verdictOutcome(registryResult.verdict));
          return;
        }
        // native / adjacent / unknown — fall through to scan
        if (registryResult.found) registryAnswer = registryResult;
      } catch (err) {
        if (!(err instanceof PackageNotFoundError)) {
          // Unexpected registry error — don't fail the scan, just log and continue.
          // The user asked for trust info; let the scan produce something useful.
          // A registry error can quote the registry's response body, and the
          // request URL with its user name and password. The `--json` document
          // carries it as `registryError`.
          registryError = registryErrorMessage(err);
          const message = redactUrlUserinfo(stripControlCharacters(registryError));
          console.error(
            chalk.dim(`  Registry lookup failed (${message}); proceeding with local scan.`),
          );
        }
        // PackageNotFoundError: registry doesn't know this package — scan it.
        // We deliberately do NOT consult the name allowlist here; a novel
        // package with a library-ish name could just as easily be a typosquat
        // as a legitimate library, and scanning costs nothing beyond latency.
        // Nor is a pip: target asked about by its bare name, as --no-scan
        // does: the answer for the name can be another package's, and a
        // library answer would skip the scan.
      }

      await handleScanFlow(
        pkg,
        client,
        globalOpts,
        opts,
        `Scanning ${name}...`,
        textOpts,
        { answer: registryAnswer, error: registryError }
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

  if (!(await checkHmaReady(target, globalOpts.json))) return;

  const shouldScan = await confirm("No trust data yet. Scan it now?", true);
  if (!shouldScan) {
    finish("not-found");
    return;
  }

  await handleScanFlow(target, client, globalOpts, opts, "Scanning...");
}

/** The usage error for a target that names no package. */
function invalidTargetProblem(target: InvalidTarget): string {
  switch (target.reason) {
    case "empty":
      return `No package name given. Usage: ${checkCitation()} <package>`;
    case "no-package-name": {
      const placeholder =
        target.prefix === "skill:" || target.prefix === "mcp:" ? "<name>" : "<package>";
      return `No package name after "${target.prefix}". Usage: ${checkCitation()} ${target.prefix}${placeholder}`;
    }
    case "no-version":
      return `No version after "${target.name}@". Usage: ${checkCitation()} ${target.name}@<version>, or ${checkCitation()} ${target.name} without the "@"`;
    case "control-characters":
      return `The package name contains control characters. Usage: ${checkCitation()} <package>`;
  }
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
  statusMessage: string,
  textOpts: Pick<FormatScanResultOptions, "all" | "rerunCommand"> = {},
  registry: {
    /** The registry's answer, when it has the package. */
    answer?: TrustAnswer;
    /** Why the registry lookup failed, when it did. */
    error?: string;
  } = {}
): Promise<void> {
  const { spec: name, ecosystem } = target;
  const registryAnswer = registry.answer;
  if (!(await checkHmaReady(target, globalOpts.json))) return;

  console.error(chalk.gray(statusMessage));

  let scanResult: ScanResult;
  try {
    // A `<name>@<version>` target downloads that version, and a
    // `pip:<name>@<version>` target that release: the downloader checks the
    // name and the version apart.
    scanResult = await scanPackage(target.name, {
      deep: opts.deep ?? true,
      analm: opts.analm,
      ecosystem,
      version: target.kind === "git" ? undefined : target.version,
    });
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
    console.log(
      formatJson(
        buildCheckJson({
          kind: "scan",
          scan: scanResult,
          ecosystem,
          registry: registryAnswer,
          registryError: registry.error,
          requestedVersion: targetVersion(target),
        }),
      ),
    );
  } else {
    // The registry's score printed beside this scan's is the package's, not
    // the scanned version's: the note says so first, as it does before the
    // registry's answer with --no-scan.
    if (registryAnswer && showsRegistryScore(registryAnswer, scanResult)) notePackageAnswer(target);
    console.log(
      formatScanResult(scanResult, { remote: true, ecosystem, ...textOpts, registry: registryAnswer }),
    );
  }
  if (opts.analm) noteAnalystLayer(scanResult.scan.analystLayer);

  // Set exit code based on verdict (2 = policy signal, matching audit/batch)
  finish(verdictOutcome(scanResult.verdict));

  // The scan ping and the community contribution: whether to share is
  // decided by decideContribution, with the same inputs as `audit`. A scan is
  // shared under the package name, without a version.
  await shareScans("check", [{ name: target.name, scanResult }], {
    flag: opts.contribute,
    registryUrl: globalOpts.registryUrl,
    ecosystem,
    type: opts.type,
  });
}

/**
 * Print the --analm note: whether the scanner's analyst layer ran, or why
 * not. On stderr, so `--json` output on stdout stays one JSON document.
 */
function noteAnalystLayer(status: Parameters<typeof analystLayerNote>[0]): void {
  console.error(chalk.dim(`  ${analystLayerNote(status)}`));
}

/**
 * The registry's miss with --no-scan. The registry looks a package up by name
 * and type when --type is given, so the miss is for that type, and the output
 * names it.
 */
function handleNoScanNotFound(
  target: PackageTarget,
  globalOpts: { registryUrl: string; json: boolean },
  type?: string
): void {
  const { spec: name, ecosystem } = target;
  if (globalOpts.json) {
    const asType = type ? ` as type ${type}` : "";
    console.log(formatJson(buildNotFoundOutput({
      name,
      ecosystem,
      error: `Package "${name}" not found in the OpenA2A Registry${asType}.`,
      nextSteps: [
        // Without --no-scan, check downloads and scans the package.
        `${checkCitation()} ${shellArg(name)}`,
        `npx hackmyagent secure <project-dir>`,
      ],
    })));
  } else {
    // Shared cli-ui renderNotFoundBlock output (F2 from the check-command-divergence brief).
    console.log(formatNotFound({ pkg: name, ecosystem, type }));
  }
  finish("not-found");
}

/**
 * Whether the scanner runs. When it does not, print why and set the error
 * exit code. With --json the message is the error of one object on stdout,
 * the object handleScanFlow prints when the scan of `target` fails.
 */
async function checkHmaReady(target: PackageTarget, asJson: boolean): Promise<boolean> {
  const available = await isHmaAvailable();
  if (!available) {
    const startProblem = scannerNodeVersionProblem() ?? scannerTempDirProblem();
    const problem = startProblem
      ? `HMA (HackMyAgent) is required for scanning, and it could not be started. ${startProblem}`
      : "HMA (HackMyAgent) is required for scanning. ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:";
    if (asJson) {
      // The reinstall command, on a line of its own in text output, ends
      // the error.
      console.log(formatJson(buildNotFoundOutput({
        name: target.spec,
        ecosystem: target.ecosystem,
        error: startProblem ? problem : `${problem} ${reinstallCommand()}`,
      })));
    } else {
      console.error(problem);
      if (!startProblem) console.error(`  ${reinstallCommand()}`);
    }
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
  // check --scan-path read 0 files: nothing was scored.
  "not-measured": 2,
  // check --scan-path could not scan: the directory does not exist, or the
  // scanner gave no report.
  "scan-not-run": 2,
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
 * Print a usage error and set its exit code. With --json the message is the
 * `error` of one object on stdout, as for a --registry-url usage error.
 */
function usageError(problem: string, json: boolean): void {
  if (json) {
    console.log(formatJson({ error: problem }));
  } else {
    console.error(`Error: ${problem}`);
  }
  finish("usage-error");
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

/** The version or tag a `<name>@<version>` target gives, or undefined. */
function targetVersion(target: PackageTarget): string | undefined {
  return target.kind === "git" ? undefined : target.version;
}

/**
 * The registry's answer for a package, or undefined when it has none. The
 * registry can answer a miss with the all-zero package id instead of a 404;
 * the client reads that as found: false. Both are the same miss, with the
 * same output and exit code.
 */
async function findInRegistry(
  client: RegistryClient,
  name: string,
  type: string | undefined,
): Promise<TrustAnswer | undefined> {
  try {
    const answer = await client.checkTrust(name, type);
    return answer.found ? answer : undefined;
  } catch (err) {
    if (err instanceof PackageNotFoundError) return undefined;
    throw err;
  }
}

/**
 * A pip: target the registry has no PyPI package for is answered, with
 * --no-scan, by the registry's answer for the name with no ecosystem. Say so
 * on stderr before the answer.
 */
function noteBareNameAnswer(target: PackageTarget): void {
  const name = stripControlCharacters(target.name);
  console.error(
    chalk.dim(
      `  Note: the registry has no PyPI package named ${name}; its answer is for the name ${name} with no ecosystem given.`,
    ),
  );
}

/**
 * The registry is asked about a `<name>@<version>` or `pip:<name>@<version>`
 * target by its name alone, so the answer shown for it is the package's, not
 * that version's. Say so on stderr before the answer.
 */
function notePackageAnswer(target: PackageTarget): void {
  if (target.kind === "git" || target.version === undefined) return;
  const name = stripControlCharacters(target.name);
  const version = stripControlCharacters(target.version);
  console.error(
    chalk.dim(`  Note: the registry's answer is for the package ${name}, not for version ${version}.`)
  );
}

/**
 * What the registry is asked for the narrative of a `skill:` or `mcp:` target.
 * The registry keeps a narrative by package name and version, so a
 * `<name>@<version>` target asks for the narrative of `<name>` at `<version>`.
 * Any other target asks for the name as typed, at the latest version.
 */
function narrativeLookup(target: RichTarget): { name: string; version?: string } {
  const { fallback } = target;
  if (fallback.kind !== "npm" || fallback.version === undefined) return { name: target.name };
  const suffix = `@${fallback.version}`;
  if (!target.name.endsWith(suffix)) return { name: target.name };
  return { name: target.name.slice(0, -suffix.length), version: fallback.version };
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
      nextSteps: [`npx hackmyagent check ${hmaCheckTarget(result.name, ecosystem)}`],
      registryData: result,
    }));
    return;
  }
  // The name is the registry's string: control characters are removed first.
  // The notice is the command's result, so it goes to stdout like the JSON.
  const name = stripControlCharacters(result.name);
  console.log("");
  console.log(
    `  ${chalk.bold.white(name)}${ecosystemSuffix(ecosystem)}  ${chalk.dim("library (registry-classified)")}`
  );
  console.log(
    `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 the registry classifies this as a general-purpose library.")}`
  );
  console.log(`  ${chalk.dim("For a thorough security audit:")}`);
  console.log(`    ${chalk.cyan(`npx hackmyagent check ${hmaCheckTarget(name, ecosystem)}`)}`);
  console.log("");
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
 * registry confirmation so the user knows we haven't verified anything. The
 * allowlist matched the package name, so the notice names the package, not
 * a version a `<name>@<version>` target gave.
 */
function printOutOfScopeByName(target: PackageTarget, asJson: boolean): void {
  const { name, ecosystem } = target;
  if (asJson) {
    console.log(formatJson({
      name,
      ecosystem,
      found: false,
      outOfScope: true,
      scored: false,
      outOfScopeReason: "recognized as general-purpose library by name (no registry data)",
      nextSteps: [`npx hackmyagent check ${hmaCheckTarget(name, ecosystem)}`],
    }));
  } else {
    console.log("");
    console.log(
      `  ${chalk.bold.white(name)}${ecosystemSuffix(ecosystem)}  ${chalk.dim("library (by name — no registry data)")}`
    );
    console.log(
      `  ${chalk.cyan("Out of scope for ai-trust")} ${chalk.dim("\u2014 ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).")}`
    );
    console.log("");
    console.log(`  For general security scanning, use HackMyAgent:`);
    console.log(`    ${chalk.cyan(`npx hackmyagent check ${hmaCheckTarget(name, ecosystem)}`)}`);
    console.log("");
  }
}
