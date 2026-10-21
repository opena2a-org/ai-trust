/**
 * HMA (HackMyAgent) subprocess runner.
 * Detects availability and runs security scans against downloaded packages.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  type Dirent,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordEarlierNo } from "../telemetry/opt-in.js";
import { maskSecrets, maskSecretsIn } from "./mask-secrets.js";

const execFileAsync = promisify(execFile);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface SemanticFinding {
  intentClass: string;
  attackClass: string;
  confidence: number;
  file: string;
}

export interface AnalystFinding {
  taskType: string;
  result: Record<string, unknown>;
  confidence: number;
  modelVersion: string;
  durationMs: number;
  backend: string;
}

/**
 * Counts from HMA's `coverageSweep`, which its JSON report carries when its
 * analyst layer ran: `swept` artifacts were sent to the analyst, and
 * `nullVerdicts` of them came back without a verdict.
 */
export interface AnalystSweep {
  swept: number;
  nullVerdicts: number;
}

/**
 * Whether HMA's analyst layer ran on a scan that asked for it (--analm).
 * `ran` is read from the report: an analyst finding or a coverage sweep.
 * When it did not run, `reason` is "flag-rejected" when the scanner refused
 * --analm, "static-only" when the scan ran with --static-only (HMA skips its
 * semantic pass, which the analyst runs inside), and "no-analyst-output"
 * otherwise (HMA runs the analyst only when its analyst daemon answers).
 */
export type AnalystLayerStatus =
  | { ran: true; findingsAnalyzed: number; sweep?: AnalystSweep }
  | { ran: false; reason: "flag-rejected" | "static-only" | "no-analyst-output" };

export interface HmaScanResult {
  score: number;
  maxScore: number;
  findings: HmaFinding[];
  /**
   * Number of static checks HMA actually executed (passed + failed), from
   * HMA's `allFindings`. `findings` carries only the failures, so this is the
   * honest "how much was measured" denominator: when it is 0 there were no
   * analyzable surfaces and the score is vacuous, not earned. Optional so
   * older HMA output (and synthetic fixtures) without `allFindings` parse;
   * the live parser always sets it.
   */
  checksEvaluated?: number;
  /**
   * Number of executed checks that passed: the records of HMA's
   * `allFindings` with `passed: true`. A not-applicable record carries no
   * `passed` and is not counted. Unset when the report has no `allFindings`.
   */
  checksPassed?: number;
  /**
   * Number of files HMA read in the target, from HMA's
   * `coverage.filesExamined`. 0 means there was nothing to scan: the checks
   * that still ran report files that are absent, so the score measures
   * nothing. Unset when HMA reported no whole-number count.
   */
  filesExamined?: number;
  /**
   * Number of inputs HMA discovered in the target but could not read (a
   * permission error, for example), from HMA's
   * `coverage.unreadableInputs.count`. When it is above 0, a scan that read
   * 0 files still found files, and its findings say which could not be read.
   * Unset when HMA reported no whole-number count.
   */
  unreadableInputs?: number;
  /**
   * `checksEvaluated` without the semantic layer's records (`AST-*`,
   * `SEM-*`), so the Checks line does not count those as static checks.
   */
  staticChecksEvaluated?: number;
  /**
   * Artifacts the scanner's semantic layer compiled, the number HMA itself
   * prints as `N semantic (NanoMind AST)`. Read from
   * `coverage.semanticFamilyCoverage.artifactsCompiled`; undefined when the
   * scanner JSON carries no such count (an older HMA), so a missing count is
   * never shown as 0.
   */
  semanticCount?: number;
  /** True when HMA ran with --static-only, so the semantic layer did not run. */
  staticOnly?: boolean;
  /** Semantic analysis results from NanoMind (present when --deep is used) */
  semanticFindings?: SemanticFinding[];
  /** AnaLM findings (present when --analm is used) */
  analystFindings?: AnalystFinding[];
  /** HMA's coverage sweep counts (present when its analyst layer ran) */
  analystSweep?: AnalystSweep;
  /** Whether the analyst layer ran; set only when the scan asked for it (--analm) */
  analystLayer?: AnalystLayerStatus;
  projectType: string;
  timestamp: string;
}

export interface HmaFinding {
  checkId: string;
  name: string;
  description: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  passed: boolean;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  /** Attack taxonomy class this finding maps to (from HMA taxonomy) */
  attackClass?: string;
}

/**
 * Resolve the pinned HMA scanner: the `hackmyagent` package Node resolves
 * for ai-trust itself, whether npm hoisted it to the consumer's top-level
 * node_modules or nested it under ai-trust. Its `bin` entry is run with the
 * current Node binary. Nothing on PATH and no npx fallback is consulted, so
 * the version pinned in package.json is the version that runs; when it is
 * not installed, resolution fails instead of running some other copy. Node
 * also looks in its global folders (the NODE_PATH entries, the
 * home-directory module folders and `<prefix>/lib/node`) after the
 * node_modules directories above ai-trust; a copy found only there, in the
 * folder or through a symlink in it, is refused. Any other copy Node's
 * resolver returns runs: one that a node_modules directory above ai-trust
 * reaches through a symlink (a node_modules that links elsewhere, or a
 * package added with `npm link`), or one a patched resolver such as Yarn
 * Plug'n'Play returns from its own cache.
 *
 * Returns { cmd, prefixArgs } where cmd=process.execPath and
 * prefixArgs=["/path/to/hackmyagent/<bin>"].
 */
let _resolvedHma: { cmd: string; prefixArgs: string[] } | null = null;

/**
 * True when the real path `entry` lies in the hackmyagent package that one of
 * Node's global folders holds, directly or through a symlink. The global
 * folders are the NODE_PATH entries, the home-directory module folders and
 * `<prefix>/lib/node`, which Node searches only after the node_modules
 * directories above the requiring module.
 */
function isInNodeGlobalFolder(entry: string): boolean {
  // Node sets `globalPaths` at startup; the module typings do not declare it.
  const globalPaths = (Module as unknown as { globalPaths?: string[] }).globalPaths ?? [];
  for (const folder of globalPaths) {
    try {
      if (entry.startsWith(realpathSync(join(folder, "hackmyagent")) + sep)) return true;
    } catch {
      // No hackmyagent in this folder.
    }
  }
  return false;
}

/**
 * True when the real path `entry` lies in the hackmyagent package that one of
 * the node_modules directories Node searches from `fromDir` holds, directly
 * or through a symlink. Node's global folders are not among those
 * directories.
 */
function isFromAncestorNodeModules(entry: string, fromDir: string): boolean {
  let dir = fromDir;
  while (true) {
    // Like Node, skip a directory that is itself named node_modules.
    if (basename(dir) !== "node_modules") {
      try {
        if (entry.startsWith(realpathSync(join(dir, "node_modules", "hackmyagent")) + sep)) return true;
      } catch {
        // No hackmyagent in this node_modules directory.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function resolveHma(): { cmd: string; prefixArgs: string[] } {
  if (_resolvedHma) return _resolvedHma;

  let entry: string;
  try {
    entry = realpathSync(createRequire(import.meta.url).resolve("hackmyagent"));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The pinned hackmyagent dependency could not be resolved: ${message.split("\n")[0]}`,
    );
  }
  if (isInNodeGlobalFolder(entry) && !isFromAncestorNodeModules(entry, MODULE_DIR)) {
    throw new Error(
      `The pinned hackmyagent dependency is not installed; the copy at ${entry} was found through one of Node's global folders (NODE_PATH, a home-directory module folder or <prefix>/lib/node), outside the node_modules directories above ai-trust`,
    );
  }

  // The package's exports do not include package.json, so walk up from the
  // resolved entry point to the package root.
  let pkgDir = dirname(entry);
  let pkg: { name?: string; bin?: string | Record<string, string> } | null = null;
  while (true) {
    const candidate = join(pkgDir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed.name === "hackmyagent") {
        pkg = parsed;
        break;
      }
    }
    const parent = dirname(pkgDir);
    if (parent === pkgDir) break;
    pkgDir = parent;
  }

  if (!pkg) {
    throw new Error(`No hackmyagent package.json was found above ${entry}`);
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hackmyagent;
  if (!bin) {
    throw new Error(`The hackmyagent package at ${pkgDir} declares no hackmyagent bin`);
  }

  _resolvedHma = { cmd: process.execPath, prefixArgs: [join(pkgDir, bin)] };
  return _resolvedHma;
}

/**
 * The standard error of the scanner's --version run when the last
 * isHmaAvailable() check failed, for scannerNodeVersionProblem(). Empty when
 * that check passed or failed without that output.
 */
let _versionCheckStderr = "";

/**
 * Check if the pinned HMA (hackmyagent) scanner is installed and runs.
 */
export async function isHmaAvailable(): Promise<boolean> {
  _versionCheckStderr = "";
  try {
    const hma = resolveHma();
    await withScannerEnv((env) =>
      execFileAsync(hma.cmd, [...hma.prefixArgs, "--version"], {
        timeout: 15_000,
        env,
      }),
    );
    return true;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: unknown } | null)?.stderr;
    _versionCheckStderr = stderr == null ? "" : String(stderr);
    return false;
  }
}

/**
 * Whether Node.js `version` loads an ES module with require() by default:
 * 20.19.0 and later 20.x releases, and 22.12.0 and later. The `engines`
 * range in package.json names the same versions.
 */
function requireLoadsEsm(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}

/**
 * Why the scanner cannot start on this Node.js, or null: the scanner's
 * --version run in the last isHmaAvailable() check failed with
 * ERR_REQUIRE_ESM, the error Node.js raises when require() is given an ES
 * module it does not load, and Node.js `nodeVersion` is not one of the
 * versions that load one by default. A reinstall does not fix that. For a
 * caller that isHmaAvailable() answered false.
 */
export function scannerNodeVersionProblem(nodeVersion: string = process.versions.node): string | null {
  if (!_versionCheckStderr.includes("ERR_REQUIRE_ESM") || requireLoadsEsm(nodeVersion)) return null;
  return `The hackmyagent version ai-trust pins loads an ES module with require(), which Node.js ${nodeVersion} does not do (ERR_REQUIRE_ESM). Run ai-trust on Node.js 20.19.0 or a later 20.x release, or on 22.12.0 or later.`;
}

function packageName(dir: string): string | undefined {
  try {
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The directory whose node_modules holds the package at `pkgDir`, or null. */
function installingDir(pkgDir: string): string | null {
  let nodeModules = dirname(pkgDir);
  if (basename(nodeModules).startsWith("@")) nodeModules = dirname(nodeModules);
  return basename(nodeModules) === "node_modules" ? dirname(nodeModules) : null;
}

function shellPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether the scan found nothing to scan: HMA read 0 files and discovered
 * no input it could not read. A scan of a directory whose files were found
 * but could not be read also read 0 files, but its findings name those files
 * and how to make them readable, so it keeps its score and findings.
 */
export function nothingToScan(scan: Pick<HmaScanResult, "filesExamined" | "unreadableInputs">): boolean {
  return scan.filesExamined === 0 && (scan.unreadableInputs ?? 0) === 0;
}

/**
 * Whether a scan measured nothing, the scans formatScanResult prints with no
 * score: it read no file and found none it could not read (nothingToScan),
 * or it executed no check and found nothing, static or semantic. Its score
 * is not a measurement, so it is not shared. A count the report did not give
 * is not read as 0.
 */
export function measuredNothing(result: {
  scan: HmaScanResult;
  semanticFindings?: SemanticFinding[];
}): boolean {
  const { scan } = result;
  if (nothingToScan(scan)) return true;
  const semantic = result.semanticFindings?.length ?? scan.semanticFindings?.length ?? 0;
  return scan.checksEvaluated === 0 && !scan.findings.some((f) => !f.passed) && semantic === 0;
}

/**
 * The command that reinstalls the pinned scanner for the way this copy of
 * ai-trust was installed: `npm install -g ai-trust` for a global install,
 * `npm install` in the project that depends on it, and the reinstall of the
 * package that depends on it otherwise (a global opena2a-cli, for example).
 */
export function reinstallCommand(fromDir: string = MODULE_DIR): string {
  let pkgDir = fromDir;
  while (packageName(pkgDir) !== "ai-trust") {
    const parent = dirname(pkgDir);
    if (parent === pkgDir) return "npm install -g ai-trust";
    pkgDir = parent;
  }
  let name = "ai-trust";
  while (true) {
    const owner = installingDir(pkgDir);
    // Not inside a node_modules: a source checkout.
    if (owner === null) return `cd ${shellPath(pkgDir)} && npm install`;
    // A global prefix holds no package.json.
    if (!existsSync(join(owner, "package.json"))) return `npm install -g ${name}`;
    // A project that depends on the package directly.
    if (installingDir(owner) === null) return `cd ${shellPath(owner)} && npm install`;
    // A package that depends on it: reinstall that package instead.
    pkgDir = owner;
    name = packageName(owner) ?? name;
  }
}

/**
 * The directories, relative to the home directory, that a deep scan reads
 * its classifier models from. The scanner downloads a missing model into
 * the first.
 */
const SCANNER_MODEL_DIRS = [".nanomind", join(".opena2a", "nanomind")];

/** The variables the pinned scanner reads to reach a remote model provider. */
const SCANNER_PROVIDER_VARS = new Set(["ANTHROPIC_API_KEY"]);

/**
 * The error for a temporary home that could not be made or removed in `dir`:
 * it names the directory, the error code and the variable that sets it.
 */
function scannerHomeError(err: unknown, failed: string, dir: string, need: string): Error {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const example = process.platform === "win32" ? "" : ", for example: export TMPDIR=/tmp";
  return new Error(
    `ai-trust runs the scanner with a new temporary home directory and ${failed} in ${dir}${code ? ` (${code})` : ""}. Point ${variable} at a directory ${need}${example}`,
  );
}

/**
 * Create a new temporary home for a scanner run in the directory
 * os.tmpdir() names. When that directory is missing or cannot be written,
 * the error names it and the variable that sets it.
 */
function createScannerHome(): string {
  const dir = tmpdir();
  try {
    return mkdtempSync(join(dir, "ai-trust-scanner-"));
  } catch (err: unknown) {
    throw scannerHomeError(err, "could not create one", dir, "that exists and that you can write to");
  }
}

/**
 * Remove a temporary home createScannerHome() made. When the directory it is
 * in lets an entry be created but not removed (on macOS, one whose access
 * control list denies delete_child), the error names that directory and the
 * variable that sets it.
 */
function removeScannerHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (err: unknown) {
    throw scannerHomeError(
      err,
      "could not remove the one it created",
      dirname(home),
      "where you can both create and remove entries",
    );
  }
}

/**
 * Why the scanner cannot start for a reason a reinstall does not fix, or
 * null: the temporary directory cannot hold its temporary home, because the
 * home cannot be created there or, once created, cannot be removed. For a
 * caller that isHmaAvailable() answered false.
 */
export function scannerTempDirProblem(): string | null {
  try {
    removeScannerHome(createScannerHome());
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Run `fn` with the environment for a scanner subprocess. Left to itself,
 * the scanner reads the saved contribution choice from
 * ~/.opena2a/config.json (or $OPENA2A_HOME/config.json), moves an opt-in
 * from its legacy ~/.hackmyagent/config.json into that file, counts its
 * scans there, and sends classification and usage telemetry when the saved
 * choices read as on; `--no-contribute` changes none of that. So the
 * scanner runs with HOME, USERPROFILE, OPENA2A_HOME and XDG_CONFIG_HOME in a
 * new temporary directory, removed afterwards, and with OPENA2A_TELEMETRY
 * set to off and ORT_DISABLE_TELEMETRY set, so the onnxruntime-node its deep
 * scan loads keeps no telemetry database under Library/Application Support/
 * Microsoft/DeveloperTools/.onnxruntime in that home; every decision ai-trust
 * made reaches it as a flag. The model
 * directories are linked into that directory, so a deep scan finds its
 * models, and keeps one it downloads, where it did before. The scanner runs
 * without SCANNER_PROVIDER_VARS, so a deep scan, the default, sends no file
 * to an LLM provider.
 */
async function withScannerEnv<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const home = createScannerHome();
  const links: string[] = [];
  try {
    try {
      // The scanner creates ~/.nanomind on every run; creating it here first
      // keeps a model it downloads in the user's home.
      mkdirSync(join(homedir(), ".nanomind"), { recursive: true });
    } catch {
      // A home it cannot write to: the scan runs without a model cache.
    }
    for (const dir of SCANNER_MODEL_DIRS) {
      const target = join(homedir(), dir);
      if (!existsSync(target)) continue;
      const link = join(home, dir);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, "junction");
      links.push(link);
    }
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    // Windows reads a variable's name in any letter case.
    for (const name of Object.keys(inherited)) {
      if (SCANNER_PROVIDER_VARS.has(name.toUpperCase())) delete inherited[name];
    }
    return await fn({
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      OPENA2A_HOME: join(home, ".opena2a"),
      XDG_CONFIG_HOME: join(home, ".config"),
      OPENA2A_TELEMETRY: "off",
      ORT_DISABLE_TELEMETRY: "1",
    });
  } finally {
    // The links go first, so removing the directory cannot reach what they point to.
    for (const link of links) rmSync(link, { force: true });
    removeScannerHome(home);
  }
}

/**
 * The error runHmaScan throws when a scanner run gives no report ai-trust
 * can read. Its message is "HMA scan failed: " followed by the run's error,
 * with the scanner's standard error in it, which can quote the scanned files:
 * a key in it is masked.
 */
export class HmaScanError extends Error {
  constructor(message: string) {
    super(`HMA scan failed: ${maskSecrets(message)}`);
    this.name = "HmaScanError";
  }
}

/**
 * Run HMA security scan against a directory.
 *
 * @returns Parsed scan results
 * @throws If HMA is not available or scan fails to produce valid output
 */
export interface HmaScanOptions {
  /**
   * Enable NanoMind semantic analysis via HMA --deep flag. Defaults to true.
   * When false, HMA runs with --static-only (static checks only).
   */
  deep?: boolean;
  /** Enable AnaLM analysis via HMA --analm flag. Defaults to false. */
  analm?: boolean;
  /**
   * The registry package the scanned directory was unpacked from. When the
   * scanner's report is larger than ai-trust reads, the error names the
   * directory as that package and gives the command that scans it with the
   * scanner directly.
   */
  downloadedPackage?: DownloadedPackage;
}

/** A registry package ai-trust downloaded and unpacked to scan. */
export interface DownloadedPackage {
  name: string;
  ecosystem: "npm" | "pypi";
  /** The version or tag downloaded instead of the latest, when one was given. */
  version?: string;
}

export async function runHmaScan(
  targetDir: string,
  options: HmaScanOptions = {}
): Promise<HmaScanResult> {
  const deep = options.deep ?? true;
  const analm = options.analm ?? false;
  const hma = resolveHma();
  // Always pass --no-contribute: ai-trust decides about contribution itself
  // (check/audit honour --contribute / --no-contribute and the saved choice).
  // Each counted scan raises the saved scan count, and a "no" saved without a
  // mark can be told from no choice only while that count is below 3, so
  // such a "no" is marked before the scan.
  recordEarlierNo();
  const args = [...hma.prefixArgs, "secure", "--format", "json", "--no-contribute"];
  if (deep) {
    args.push("--deep");
  } else {
    // Without this, HMA still runs its default AST semantic analysis.
    args.push("--static-only");
  }
  if (analm) {
    args.push("--analm");
  }
  args.push(targetDir);

  return withScannerEnv(async (env) => {
    let attemptArgs = args;
    for (;;) {
      try {
        const result = await runHmaWithArgs(hma.cmd, attemptArgs, deep, env);
        if (analm) {
          result.analystLayer = analystLayerStatus(result, deep, attemptArgs.includes("--analm"));
        }
        // Only when HMA accepted the flag: an older HMA that rejected it ran
        // its default semantic analysis on the retry.
        if (attemptArgs.includes("--static-only")) {
          result.staticOnly = true;
        }
        return result;
      } catch (err: unknown) {
        // A scanner without --no-contribute would decide about contribution
        // from the saved choice, so the scan is not run again without it.
        if (isUnknownOptionError(err, "--no-contribute")) {
          throw new HmaScanError(
            "the scanner does not accept --no-contribute, which ai-trust passes so that only ai-trust decides what a scan shares; ai-trust does not scan without it. " +
              `Reinstall the hackmyagent version ai-trust pins: ${reinstallCommand()}`,
          );
        }
        // If an optional flag caused "unknown option", retry without it (older HMA version)
        const rejected = OPTIONAL_HMA_FLAGS.find(
          (flag) => attemptArgs.includes(flag) && isUnknownOptionError(err, flag)
        );
        if (!rejected) {
          if (isReportTooLarge(err)) {
            throw new HmaScanError(reportTooLargeMessage(targetDir, options.downloadedPackage));
          }
          const message = err instanceof Error ? err.message : String(err);
          throw new HmaScanError(message);
        }
        attemptArgs = attemptArgs.filter((a) => a !== rejected);
      }
    }
  });
}

/**
 * Flags that older HMA versions may not recognise; the scan retries without
 * them. `--no-contribute` is not one: runHmaScan fails without it.
 */
const OPTIONAL_HMA_FLAGS = ["--static-only", "--analm"];

/**
 * Read whether the analyst layer ran from the scan's report. A report with
 * analyst output says it ran; without any, the reason is the first of: the
 * scanner refused --analm, the scan was static-only, or no analyst output.
 */
function analystLayerStatus(
  scan: HmaScanResult,
  deep: boolean,
  flagAccepted: boolean,
): AnalystLayerStatus {
  const findingsAnalyzed = scan.analystFindings?.length ?? 0;
  if (scan.analystSweep || findingsAnalyzed > 0) {
    return { ran: true, findingsAnalyzed, ...(scan.analystSweep ? { sweep: scan.analystSweep } : {}) };
  }
  if (!flagAccepted) return { ran: false, reason: "flag-rejected" };
  if (!deep) return { ran: false, reason: "static-only" };
  return { ran: false, reason: "no-analyst-output" };
}

function isUnknownOptionError(err: unknown, flag: string): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
  const message = err instanceof Error ? err.message : "";
  return (stderr + message).includes(`unknown option '${flag}'`);
}

/**
 * Largest scanner report, in bytes, that ai-trust reads from stdout. Node's
 * `execFile` default is 1 MiB; the report grows with the findings it lists,
 * and a report over the limit fails the scan with "stdout maxBuffer length
 * exceeded".
 */
const HMA_MAX_REPORT_BYTES = 128 * 1024 * 1024;

/**
 * Whether a run failed because the scanner wrote more than
 * HMA_MAX_REPORT_BYTES to stdout, where its report goes: `execFile` then
 * rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the message "stdout
 * maxBuffer length exceeded". The same code with "stderr" is not the report,
 * and keeps Node's message.
 */
function isReportTooLarge(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
    err.message.startsWith("stdout")
  );
}

/**
 * The error for a report larger than HMA_MAX_REPORT_BYTES: the limit, the
 * files and bytes of the scanned directory, and for a downloaded package the
 * command that scans it with the scanner directly. That command takes the
 * package name alone: `hackmyagent check` 0.33.2 reads an npm
 * `<name>@<version>` as a skill identifier and a PyPI one as the name of a
 * package it does not find, and does not apply `--at` to an npm or PyPI
 * package.
 */
function reportTooLargeMessage(dir: string, pkg: DownloadedPackage | undefined): string {
  const parts = [
    `the scanner's report is larger than ${HMA_MAX_REPORT_BYTES / (1024 * 1024)} MiB, the most ai-trust reads.`,
  ];
  const size = directorySize(dir);
  if (size) {
    const files = `${size.files.toLocaleString("en-US")} ${size.files === 1 ? "file" : "files"}`;
    parts.push(
      `${pkg ? "The package unpacks to" : "The scanned directory holds"} ${size.partial ? "at least " : ""}${files}, ${formatBytes(size.bytes)}.`,
    );
  }
  if (pkg) {
    const target = shellPath(pkg.ecosystem === "pypi" ? `pip:${pkg.name}` : pkg.name);
    const byName = pkg.version === undefined ? "" : " (by name; its check takes no version)";
    parts.push(`Run the scanner on it directly${byName}: npx hackmyagent check ${target}`);
  }
  return parts.join(" ");
}

/** The regular files under a directory and their total size in bytes. */
interface DirectorySize {
  files: number;
  bytes: number;
  /** A subdirectory or a file could not be read, so the counts are a lower bound. */
  partial: boolean;
}

/**
 * Count the regular files under `dir` and add up their sizes. A symlink is
 * neither followed nor counted. Undefined when `dir` itself cannot be read.
 */
function directorySize(dir: string): DirectorySize | undefined {
  const size: DirectorySize = { files: 0, bytes: 0, partial: false };
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      if (current === dir) return undefined;
      size.partial = true;
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        try {
          size.bytes += lstatSync(path).size;
          size.files += 1;
        } catch {
          size.partial = true;
        }
      }
    }
  }
  return size;
}

/** A byte count in bytes, or in KiB, MiB or GiB to one decimal place. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (Number(value.toFixed(1)) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function runHmaWithArgs(
  cmd: string,
  args: string[],
  deep: boolean,
  env: NodeJS.ProcessEnv,
): Promise<HmaScanResult> {
  try {
    const { stdout } = await execFileAsync(
      cmd,
      args,
      { timeout: deep ? 180_000 : 120_000, maxBuffer: HMA_MAX_REPORT_BYTES, env }
    );

    return parseHmaOutput(stdout);
  } catch (err: unknown) {
    // HMA exits with code 1 when it finds issues but still outputs JSON
    if (
      err &&
      typeof err === "object" &&
      "stdout" in err &&
      typeof (err as { stdout: unknown }).stdout === "string"
    ) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout.trim()) {
        try {
          return parseHmaOutput(stdout);
        } catch {
          // Fall through to throw
        }
      }
    }
    // Unwrapped: runHmaScan reads the scanner's stderr from this error to
    // decide on a retry, and adds the "HMA scan failed: " prefix itself.
    throw err;
  }
}

function parseHmaOutput(stdout: string): HmaScanResult {
  // HMA may output non-JSON lines before the JSON; find the JSON object
  const lines = stdout.split("\n");
  let jsonStr = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      jsonStr = lines.slice(i).join("\n");
      break;
    }
  }

  if (!jsonStr) {
    throw new Error("No JSON output found from HMA scan");
  }

  const raw = JSON.parse(jsonStr);

  // `allFindings` lists every executed check (passed + failed); `findings` is
  // failures only. Prefer the former as the executed-checks count, falling
  // back to the failures count when an older HMA omits `allFindings`.
  const executed: Array<Record<string, unknown> | null> = Array.isArray(raw.allFindings)
    ? raw.allFindings
    : Array.isArray(raw.findings)
      ? raw.findings
      : [];
  const checksEvaluated = executed.length;
  // HMA files `AST-*` (NanoMind) and `SEM-*` (structural) records under its
  // semantic layer, so they are not counted as static checks.
  const staticChecksEvaluated = executed.filter(
    (f) => !/^(AST|SEM)-/.test(String(f?.checkId ?? "")),
  ).length;

  const result: HmaScanResult = {
    score: raw.score ?? 0,
    maxScore: raw.maxScore ?? 100,
    checksEvaluated,
    ...(Array.isArray(raw.allFindings)
      ? { checksPassed: executed.filter((f) => f?.passed === true).length }
      : {}),
    staticChecksEvaluated,
    // The text of a finding can quote the scanned files, a key in them
    // included.
    findings: (raw.findings ?? []).map((f: Record<string, unknown>) => ({
      checkId: f.checkId ?? "",
      name: maskSecretsIn(f.name ?? ""),
      description: maskSecretsIn(f.description ?? ""),
      category: f.category ?? "",
      severity: f.severity ?? "low",
      passed: f.passed ?? true,
      message: maskSecrets(String(f.message ?? "")),
      file: f.file,
      line: f.line,
      fix: maskSecretsIn(f.fix),
      attackClass: f.attackClass as string | undefined,
    })),
    projectType: raw.projectType ?? "unknown",
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };

  const filesExamined = raw.coverage?.filesExamined;
  if (Number.isInteger(filesExamined) && filesExamined >= 0) {
    result.filesExamined = filesExamined;
  }
  const unreadableInputs = raw.coverage?.unreadableInputs?.count;
  if (Number.isInteger(unreadableInputs) && unreadableInputs >= 0) {
    result.unreadableInputs = unreadableInputs;
  }
  // HMA's own `N semantic (NanoMind AST)` is its compile count. Not
  // `semanticAnalysis.layer2Findings`: that counts structural findings, is
  // omitted when there are none, and stays set under --static-only.
  const compiled = raw.coverage?.semanticFamilyCoverage?.artifactsCompiled;
  if (typeof compiled === "number") {
    result.semanticCount = compiled;
  }

  // Parse NanoMind semantic findings when present (from --deep mode)
  if (Array.isArray(raw.semanticFindings) && raw.semanticFindings.length > 0) {
    result.semanticFindings = raw.semanticFindings.map(
      (sf: Record<string, unknown>) => ({
        intentClass: (sf.intentClass as string) ?? "unknown",
        attackClass: (sf.attackClass as string) ?? "unknown",
        confidence: typeof sf.confidence === "number" ? sf.confidence : 0,
        file: (sf.file as string) ?? "",
      })
    );
  }

  // Parse analyst findings when present (from --analyze mode). Their result
  // can quote the scanned files as a finding does.
  if (Array.isArray(raw.analystFindings) && raw.analystFindings.length > 0) {
    result.analystFindings = raw.analystFindings.map(
      (af: Record<string, unknown>) => ({
        taskType: (af.taskType as string) ?? "unknown",
        result: maskSecretsIn((af.result as Record<string, unknown>) ?? {}),
        confidence: typeof af.confidence === "number" ? af.confidence : 0,
        modelVersion: (af.modelVersion as string) ?? "unknown",
        durationMs: typeof af.durationMs === "number" ? af.durationMs : 0,
        backend: (af.backend as string) ?? "unknown",
      })
    );
  }

  // HMA reports its coverage sweep only when its analyst layer ran.
  if (raw.coverageSweep && typeof raw.coverageSweep === "object") {
    const sweep = raw.coverageSweep as Record<string, unknown>;
    result.analystSweep = {
      swept: typeof sweep.swept === "number" ? sweep.swept : 0,
      nullVerdicts: typeof sweep.nullVerdicts === "number" ? sweep.nullVerdicts : 0,
    };
  }

  return result;
}
