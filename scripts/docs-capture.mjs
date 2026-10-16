#!/usr/bin/env node
/**
 * docs:capture: re-captures the README's first command from the build.
 *
 * It runs `node dist/index.js check @modelcontextprotocol/server-filesystem
 * --no-scan`, the README's first command without `npx`, from an empty working
 * directory, with an empty HOME and an environment that holds only PATH,
 * CI=true, TERM=dumb, LANG=en_US.UTF-8 and OPENA2A_TELEMETRY=off. Then it
 * writes three files:
 *   - docs/captures/quick-start.txt, what the run printed on stdout;
 *   - docs/captures/quick-start.json, the record of the run: the version in
 *     package.json, the commit checked out, the build inputs that differ from
 *     it, whether it is the release tag, the registry, the environment, the
 *     exit code, and the capture's size and SHA-256;
 *   - README.md, whose sample block under the
 *     "[full output](docs/captures/quick-start.txt)" label becomes the
 *     capture's lines less the blank ones at its start and end.
 * A run that exits non-zero or prints on stderr writes none of them.
 *
 * Run `npm run build` first: the capture is of dist/index.js as it is.
 *
 * --check writes nothing and reports where the three files disagree: a
 * capture whose size or SHA-256 differs from its record, a record whose
 * command, version or exit code is not the README's first command, the
 * version in package.json and 0, and a README sample that is not the
 * capture's lines. When the root is the top of a git work tree, it also
 * reports a record whose commit is not a full commit hash naming HEAD or an
 * ancestor of it. It leaves that commit unchecked, and says so on stdout,
 * when the root is not the top of a work tree, and in a shallow clone that
 * finds no path from HEAD to the commit.
 *
 * Usage: node scripts/docs-capture.mjs [--registry-url <url>] [--root <dir>]
 *        node scripts/docs-capture.mjs --check [--root <dir>]
 * Exit 0 on success, 1 when a file it reads cannot be read or parsed, the run
 * fails or --check finds a difference, 2 on a usage error (an unknown
 * argument, a flag with no value, or a --root that does not exist or is not a
 * directory).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMAND = "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan";
export const CAPTURE = "docs/captures/quick-start.txt";
export const SIDECAR = "docs/captures/quick-start.json";
export const README = "README.md";
const CLI = "dist/index.js";
const LABEL = `[full output](${CAPTURE})`;
const VARIABLES = { CI: "true", TERM: "dumb", LANG: "en_US.UTF-8", OPENA2A_TELEMETRY: "off" };
const RECAPTURE = "run npm run build, then npm run docs:capture";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The text of `rel` under `root`, or the reason it cannot be read. */
function readText(root, rel) {
  try {
    return { text: readFileSync(join(root, rel), "utf8") };
  } catch (error) {
    return { error: `cannot read ${rel}: ${error.message}` };
  }
}

/** The version in package.json under `root`, or the reason it cannot be read or parsed. */
function packageVersion(root) {
  const pkg = readText(root, "package.json");
  if (pkg.error) return pkg;
  try {
    return { version: JSON.parse(pkg.text).version };
  } catch (error) {
    return { error: `cannot read package.json: ${error.message}` };
  }
}

/** A recorded value as a message shows it. */
function shown(value) {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

/** The capture's lines: its text split at newlines, less the empty string after the final one. */
function captureLines(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The 0-based indexes of the capture's first and last non-blank lines, or null when every line is blank. */
export function excerptRange(lines) {
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return null;
  let last = lines.length - 1;
  while (lines[last].trim() === "") last--;
  return { first, last };
}

/**
 * The README split into lines, with the indexes of the fences that open and
 * close the sample block under the capture label, or the reason there is none.
 */
export function readmeSample(readme) {
  const lines = readme.split("\n");
  const label = lines.findIndex((line) => line.includes(LABEL));
  if (label === -1) return { error: `${README} has no line with the label ${LABEL}` };
  let open = label + 1;
  while (open < lines.length && lines[open].trim() === "") open++;
  if (open === lines.length || !lines[open].startsWith("```")) {
    return { error: `${README} has no fenced block right after the label ${LABEL} (line ${label + 1})` };
  }
  const close = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line));
  if (close === -1) return { error: `the fenced block at ${README}:${open + 1} has no closing fence` };
  return { lines, open, close };
}

/**
 * The variables git exports to the commands it starts, as a hook or a command
 * run in a linked work tree is (`git rev-parse --local-env-vars`). With one of
 * them set, git answers about that repository whatever `-C` names.
 */
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** The environment for a git run here: the process's, less the variables above, so that `-C <root>` alone names the repository. */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCAL_ENV_VARS.includes(name)));
}

/**
 * Whether `top`, the top-level directory git reports, is the directory `root`
 * names. realpathSync.native, unlike realpathSync, also gives each name its
 * stored letter case, so a root typed in another case on a case-insensitive
 * file system still matches.
 */
function isWorkTreeTop(top, root) {
  return realpathSync.native(top) === realpathSync.native(root);
}

/**
 * Whether `commit`, the commit the record names, is HEAD or an ancestor of it
 * in the work tree whose top is `root`: { problem } when it is not, { unchecked }
 * with the reason when that cannot be told here, and {} when it is.
 */
export function checkRecordedCommit(root, commit) {
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv() });
  const top = git("rev-parse", "--show-toplevel");
  if (top.error) return { unchecked: `git could not be run (${top.error.message})` };
  if (top.status !== 0 || !isWorkTreeTop(top.stdout.replace(/\n+$/, ""), root)) {
    return { unchecked: `${root} is not the top of a git work tree` };
  }
  if (typeof commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    return { problem: `${SIDECAR} records commit ${shown(commit)}, not a full commit hash; ${RECAPTURE}` };
  }
  if (git("merge-base", "--is-ancestor", commit, "HEAD").status === 0) return {};
  if (git("rev-parse", "--is-shallow-repository").stdout?.trim() === "true") {
    return {
      unchecked: `this clone is shallow and finds no path from HEAD to commit ${commit}, so it cannot tell whether the record's commit is in the history of HEAD; run git fetch --unshallow, then the check again`,
    };
  }
  return { problem: `${SIDECAR} records commit ${commit}, which is not HEAD or an ancestor of it; ${RECAPTURE}` };
}

/**
 * Where the capture, its record and the README sample under `root` disagree;
 * empty when they agree. A check that could not be made here is added to
 * `notes` with the reason.
 */
export function checkCapture(root, notes = []) {
  const read = (rel) => readFileSync(join(root, rel));
  let capture;
  let sidecar;
  try {
    capture = read(CAPTURE);
    sidecar = JSON.parse(read(SIDECAR).toString("utf8"));
  } catch (error) {
    return [`cannot read ${CAPTURE} and ${SIDECAR}: ${error.message}; ${RECAPTURE}`];
  }
  if (sidecar === null || typeof sidecar !== "object" || Array.isArray(sidecar)) {
    const kind = sidecar === null ? "null" : Array.isArray(sidecar) ? "an array" : `a ${typeof sidecar}`;
    return [`${SIDECAR} holds ${kind}, not a record object; ${RECAPTURE}`];
  }
  const pkg = packageVersion(root);
  if (pkg.error) return [pkg.error];
  const readme = readText(root, README);
  if (readme.error) return [readme.error];
  const problems = [];
  const version = pkg.version;
  if (sidecar.command !== COMMAND) {
    problems.push(`${SIDECAR} records the command "${sidecar.command}", not the README's first command "${COMMAND}"`);
  }
  if (sidecar.artifact?.version !== version) {
    problems.push(`${SIDECAR} records version ${shown(sidecar.artifact?.version)} and package.json holds ${version}; ${RECAPTURE}`);
  }
  const commit = checkRecordedCommit(root, sidecar.artifact?.commit);
  if (commit.problem) problems.push(commit.problem);
  if (commit.unchecked) notes.push(`the record's commit was not checked: ${commit.unchecked}`);
  if (sidecar.exitCode !== 0) {
    problems.push(`${SIDECAR} records exit code ${shown(sidecar.exitCode)}, not 0`);
  }
  if (sidecar.outputs?.capture !== CAPTURE) {
    problems.push(`${SIDECAR} names the capture ${shown(sidecar.outputs?.capture)}, not ${CAPTURE}`);
  }
  if (sidecar.outputs?.bytes !== capture.length) {
    problems.push(`${CAPTURE} is ${capture.length} bytes and ${SIDECAR} records ${shown(sidecar.outputs?.bytes)}; ${RECAPTURE}`);
  }
  const digest = sha256(capture);
  if (sidecar.outputs?.sha256 !== digest) {
    problems.push(`${CAPTURE} hashes to ${digest} and ${SIDECAR} records ${shown(sidecar.outputs?.sha256)}; ${RECAPTURE}`);
  }

  const lines = captureLines(capture.toString("utf8"));
  const range = excerptRange(lines);
  const sample = readmeSample(readme.text);
  if (range === null) {
    problems.push(`${CAPTURE} holds no output; ${RECAPTURE}`);
  } else if (sample.error) {
    problems.push(sample.error);
  } else {
    const expected = lines.slice(range.first, range.last + 1);
    const actual = sample.lines.slice(sample.open + 1, sample.close);
    if (actual.length !== expected.length || actual.some((line, i) => line !== expected[i])) {
      problems.push(
        `the ${README} sample at lines ${sample.open + 2}-${sample.close} is not lines ${range.first + 1}-${range.last + 1} of ${CAPTURE}; ${RECAPTURE}`,
      );
    }
    const excerpt = `${range.first + 1}-${range.last + 1} of the capture`;
    if (sidecar.readmeExcerpt?.lines !== excerpt) {
      problems.push(`${SIDECAR} records the README excerpt as ${shown(sidecar.readmeExcerpt?.lines)}, not "${excerpt}"`);
    }
  }
  return problems;
}

/** The registry the CLI asks when no --registry-url is given, as its --help states it. */
export function defaultRegistry(cliPath, env) {
  const help = spawnSync(process.execPath, [cliPath, "--help"], { env, encoding: "utf8" });
  const match = /--registry-url <url>\s+registry base URL\s+\(default:\s+"([^"]+)"\)/.exec(help.stdout ?? "");
  return match ? match[1] : null;
}

/**
 * The commit `root` is checked out at, the build inputs (the source under
 * src/ less its tests, package.json, package-lock.json, tsconfig.json) that
 * differ from it, and whether it is the release tag with none differing.
 */
function gitState(root, version) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).replace(
      /\n+$/,
      "",
    );
  try {
    if (!isWorkTreeTop(git("rev-parse", "--show-toplevel"), root)) throw new Error("not the top of a work tree");
    const inputs = ["src", ":(exclude,glob)src/**/*.test.ts", "package.json", "package-lock.json", "tsconfig.json"];
    const changed = git("status", "--porcelain", "--untracked-files=all", "--", ...inputs)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    const tags = git("tag", "--points-at", "HEAD").split("\n");
    return {
      commit: git("rev-parse", "HEAD"),
      uncommittedBuildInputs: changed,
      taggedRelease: changed.length === 0 && tags.includes(`v${version}`),
    };
  } catch {
    return { commit: null, uncommittedBuildInputs: null, taggedRelease: false };
  }
}

function blankLines(count) {
  return `${count} blank line${count === 1 ? "" : "s"}`;
}

/** Runs the capture under `root` and writes its three files; returns the lines to print and the exit code. */
export function capture(root, registryUrl) {
  const cliPath = join(root, CLI);
  if (!existsSync(cliPath)) return { lines: [`docs:capture: ${CLI} does not exist; run npm run build first`], exitCode: 1 };
  const readme = readText(root, README);
  if (readme.error) return { lines: [`docs:capture: ${readme.error}`], exitCode: 1 };
  const sample = readmeSample(readme.text);
  if (sample.error) return { lines: [`docs:capture: ${sample.error}`], exitCode: 1 };

  const pkg = packageVersion(root);
  if (pkg.error) return { lines: [`docs:capture: ${pkg.error}`], exitCode: 1 };
  const version = pkg.version;
  const scratch = mkdtempSync(join(tmpdir(), "ai-trust-docs-capture-"));
  const home = join(scratch, "home");
  const cwd = join(scratch, "cwd");
  try {
    for (const dir of [home, cwd]) mkdirSync(dir);
    const env = { PATH: process.env.PATH ?? "", HOME: home, ...VARIABLES };
    const registry = registryUrl ?? defaultRegistry(cliPath, env);
    if (!registry) return { lines: [`docs:capture: ${CLI} --help names no default for --registry-url`], exitCode: 1 };

    const args = [...COMMAND.split(" ").slice(2), ...(registryUrl ? ["--registry-url", registryUrl] : [])];
    const invokedAs = `node ${CLI} ${args.join(" ")}`;
    const run = spawnSync(process.execPath, [cliPath, ...args], { cwd, env });
    const stderr = run.stderr?.toString("utf8") ?? "";
    if (run.status !== 0 || stderr !== "") {
      return {
        lines: [
          `docs:capture: ${invokedAs} exited ${run.status ?? run.signal}${stderr ? " and printed on stderr" : ""}; nothing written`,
          ...stderr.split("\n").filter(Boolean).map((line) => `  ${line}`),
        ],
        exitCode: 1,
      };
    }

    const out = run.stdout;
    const lines = captureLines(out.toString("utf8"));
    const range = excerptRange(lines);
    if (range === null) return { lines: [`docs:capture: ${invokedAs} printed nothing on stdout; nothing written`], exitCode: 1 };

    const record = {
      name: "quick-start",
      command: COMMAND,
      artifact: {
        package: "ai-trust",
        version,
        build: `${CLI} as npm run build left it`,
        ...gitState(root, version),
        invokedAs,
      },
      capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      registry,
      environment: {
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        cwd: "an empty directory",
        home: "an empty directory",
        variables: VARIABLES,
      },
      exitCode: run.status,
      outputs: { capture: CAPTURE, stream: "stdout", bytes: out.length, sha256: sha256(out), stderr: "empty" },
      readmeExcerpt: {
        file: README,
        lines: `${range.first + 1}-${range.last + 1} of the capture`,
        omitted: `${blankLines(range.first)} at the start and ${blankLines(lines.length - 1 - range.last)} at the end`,
      },
    };
    const readmeLines = [
      ...sample.lines.slice(0, sample.open + 1),
      ...lines.slice(range.first, range.last + 1),
      ...sample.lines.slice(sample.close),
    ];

    writeFileSync(join(root, CAPTURE), out);
    writeFileSync(join(root, SIDECAR), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(root, README), readmeLines.join("\n"));
    return {
      lines: [
        `docs:capture: ${invokedAs} against ${registry}, exit 0`,
        `  wrote ${CAPTURE} (${out.length} bytes), ${SIDECAR}, and lines ${range.first + 1}-${range.last + 1} of the capture to the ${README} sample`,
      ],
      exitCode: 0,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), registryUrl: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") {
      args.check = true;
    } else if (flag === "--root" || flag === "--registry-url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} takes a value`);
      args[flag === "--root" ? "root" : "registryUrl"] = value;
      i++;
    } else {
      throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (args.check && args.registryUrl) throw new Error("--check runs nothing, so it takes no --registry-url");
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    let isDirectory = false;
    try {
      isDirectory = statSync(args.root).isDirectory();
    } catch {
      throw new Error(`--root "${args.root}" does not exist`);
    }
    if (!isDirectory) throw new Error(`--root "${args.root}" is not a directory`);
  } catch (error) {
    console.error(`docs:capture: ${error.message}`);
    console.error("Usage: node scripts/docs-capture.mjs [--registry-url <url>] [--root <dir>]");
    console.error("       node scripts/docs-capture.mjs --check [--root <dir>]");
    process.exit(2);
  }
  const root = resolve(args.root);
  if (args.check) {
    const notes = [];
    const problems = checkCapture(root, notes);
    for (const note of notes) console.log(`docs:capture --check: ${note}`);
    for (const problem of problems) console.error(`docs:capture --check: ${problem}`);
    if (problems.length === 0) console.log(`docs:capture --check: ${CAPTURE}, ${SIDECAR} and the ${README} sample agree.`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const result = capture(root, args.registryUrl);
  for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
  process.exit(result.exitCode);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
