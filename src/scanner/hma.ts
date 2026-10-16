/**
 * HMA (HackMyAgent) subprocess runner.
 * Detects availability and runs security scans against downloaded packages.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordEarlierNo } from "../telemetry/opt-in.js";

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
  /** Semantic analysis results from NanoMind (present when --deep is used) */
  semanticFindings?: SemanticFinding[];
  /** AnaLM findings (present when --analm is used) */
  analystFindings?: AnalystFinding[];
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
 * Check if the pinned HMA (hackmyagent) scanner is installed and runs.
 */
export async function isHmaAvailable(): Promise<boolean> {
  try {
    const hma = resolveHma();
    await withScannerEnv((env) =>
      execFileAsync(hma.cmd, [...hma.prefixArgs, "--version"], {
        timeout: 15_000,
        env,
      }),
    );
    return true;
  } catch {
    return false;
  }
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
 * Create a new temporary home for a scanner run in the directory
 * os.tmpdir() names. When that directory is missing or cannot be written,
 * the error names it and the variable that sets it.
 */
function createScannerHome(): string {
  const dir = tmpdir();
  try {
    return mkdtempSync(join(dir, "ai-trust-scanner-"));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const example = process.platform === "win32" ? "" : ", for example: export TMPDIR=/tmp";
    throw new Error(
      `ai-trust runs the scanner with a new temporary home directory and could not create one in ${dir}${code ? ` (${code})` : ""}. Point ${variable} at a directory that exists and that you can write to${example}`,
    );
  }
}

/**
 * Why the scanner cannot start for a reason a reinstall does not fix, or
 * null: the temporary directory cannot hold its temporary home. For a
 * caller that isHmaAvailable() answered false.
 */
export function scannerTempDirProblem(): string | null {
  let home: string;
  try {
    home = createScannerHome();
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  rmSync(home, { recursive: true, force: true });
  return null;
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
 * set to off; every decision ai-trust made reaches it as a flag. The model
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
    });
  } finally {
    // The links go first, so removing the directory cannot reach what they point to.
    for (const link of links) rmSync(link, { force: true });
    rmSync(home, { recursive: true, force: true });
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
        return await runHmaWithArgs(hma.cmd, attemptArgs, deep, env);
      } catch (err: unknown) {
        // If an optional flag caused "unknown option", retry without it (older HMA version)
        const rejected = OPTIONAL_HMA_FLAGS.find(
          (flag) => attemptArgs.includes(flag) && isUnknownOptionError(err, flag)
        );
        if (!rejected) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`HMA scan failed: ${message}`);
        }
        attemptArgs = attemptArgs.filter((a) => a !== rejected);
      }
    }
  });
}

/** Flags that older HMA versions may not recognise; the scan retries without them. */
const OPTIONAL_HMA_FLAGS = ["--static-only", "--analm"];

function isUnknownOptionError(err: unknown, flag: string): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
  const message = err instanceof Error ? err.message : "";
  return (stderr + message).includes(`unknown option '${flag}'`);
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
      { timeout: deep ? 180_000 : 120_000, env }
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
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`HMA scan failed: ${message}`);
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
  const checksEvaluated = Array.isArray(raw.allFindings)
    ? raw.allFindings.length
    : Array.isArray(raw.findings)
      ? raw.findings.length
      : 0;

  const result: HmaScanResult = {
    score: raw.score ?? 0,
    maxScore: raw.maxScore ?? 100,
    checksEvaluated,
    findings: (raw.findings ?? []).map((f: Record<string, unknown>) => ({
      checkId: f.checkId ?? "",
      name: f.name ?? "",
      description: f.description ?? "",
      category: f.category ?? "",
      severity: f.severity ?? "low",
      passed: f.passed ?? true,
      message: f.message ?? "",
      file: f.file,
      line: f.line,
      fix: f.fix,
      attackClass: f.attackClass as string | undefined,
    })),
    projectType: raw.projectType ?? "unknown",
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };

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

  // Parse analyst findings when present (from --analyze mode)
  if (Array.isArray(raw.analystFindings) && raw.analystFindings.length > 0) {
    result.analystFindings = raw.analystFindings.map(
      (af: Record<string, unknown>) => ({
        taskType: (af.taskType as string) ?? "unknown",
        result: (af.result as Record<string, unknown>) ?? {},
        confidence: typeof af.confidence === "number" ? af.confidence : 0,
        modelVersion: (af.modelVersion as string) ?? "unknown",
        durationMs: typeof af.durationMs === "number" ? af.durationMs : 0,
        backend: (af.backend as string) ?? "unknown",
      })
    );
  }

  return result;
}
