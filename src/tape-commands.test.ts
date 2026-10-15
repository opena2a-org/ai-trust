/**
 * Recorded commands are commands the CLI registers.
 *
 * A recording is rendered from a VHS tape under docs/. Every command a tape
 * types on screen (a `Type` line outside a `Hide`..`Show` block) must be an
 * `ai-trust` command that names a registered subcommand, uses only flags that
 * subcommand or the root command registers, gives each flag shown with
 * `<value>` a value (a whole number in the range when the flag's description
 * states one, as `(0-4)`), and passes as many arguments as the subcommand
 * takes. It parses in commander's two passes: the root command first takes
 * its own flags from wherever they stand, then the subcommand parses the
 * rest. The check asks the built CLI itself, through
 * `node dist/index.js <subcommand> --help`, so a tape cannot show a command a
 * reader would fail to run. Hidden lines are setup (a `cd` into the copy of the
 * sample project) and are not checked.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

function tapes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tapes(path);
    return entry.name.endsWith(".tape") ? [path] : [];
  });
}

/** The `Type` lines a viewer sees: those outside `Hide`..`Show`, in order. */
function typedOnScreen(tape: string): string[] {
  const typed: string[] = [];
  let hidden = false;
  for (const raw of readFileSync(tape, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "Hide") hidden = true;
    else if (line === "Show") hidden = false;
    else if (!hidden) {
      const m = line.match(/^Type(?:@\S+)?\s+(["'`])(.*)\1$/);
      if (m) typed.push(m[2]);
    }
  }
  return typed;
}

function help(args: string[]): { stdout: string; status: number | null } {
  // Minimal environment, as in docs-samples.test.ts: no host config, no telemetry.
  const scratch = mkdtempSync(join(tmpdir(), "ai-trust-tape-"));
  try {
    const run = spawnSync(process.execPath, [CLI_PATH, ...args, "--help"], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        XDG_CONFIG_HOME: scratch,
        NO_COLOR: "1",
        CI: "true",
        OPENA2A_TELEMETRY: "off",
      },
      encoding: "utf8",
    });
    return { stdout: run.stdout, status: run.status };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface FlagSpec {
  /** `<value>` in the help is required, `[value]` optional. */
  value: "none" | "required" | "optional";
  /** The whole-number range the description states, as `(0-4)`. */
  range?: { min: number; max: number };
}

/** Flags listed under "Options:" in a help text, with the value each one takes. */
function registeredFlags(helpText: string): Map<string, FlagSpec> {
  const entries: { names: string[]; value: FlagSpec["value"]; description: string }[] = [];
  let last: (typeof entries)[number] | undefined;
  for (const line of helpText.split("\n")) {
    const m = line.match(/^ {2}((?:-\w|--[\w-]+)(?:, (?:-\w|--[\w-]+))*)( [<[]\S+)?(.*)$/);
    if (m) {
      const value = m[2] === undefined ? "none" : m[2].startsWith(" <") ? "required" : "optional";
      last = { names: m[1].split(", "), value, description: m[3] };
      entries.push(last);
    } else if (last !== undefined && /^ {3,}\S/.test(line)) {
      // A description wrapped onto the next line.
      last.description += ` ${line.trim()}`;
    } else {
      last = undefined;
    }
  }
  const flags = new Map<string, FlagSpec>();
  for (const { names, value, description } of entries) {
    const r = value === "none" ? null : description.match(/\((\d+)-(\d+)\)/);
    const spec: FlagSpec = r ? { value, range: { min: Number(r[1]), max: Number(r[2]) } } : { value };
    for (const name of names) flags.set(name, spec);
  }
  return flags;
}

/** How many arguments the subcommand takes, read from its usage line. */
function arity(usage: string): { min: number; max: number } {
  const placeholders = (usage.match(/<[^>]+>|\[[^\]]+\]/g) ?? []).filter((p) => p !== "[options]");
  return {
    min: placeholders.filter((p) => p.startsWith("<")).length,
    max: placeholders.some((p) => p.includes("...")) ? Infinity : placeholders.length,
  };
}

/**
 * Takes the flags `flags` registers out of `tokens`, each with its value,
 * adding a problem for a value that is missing or out of range, and returns
 * the tokens left over, in order.
 */
function takeFlags(tokens: string[], flags: Map<string, FlagSpec>, problems: string[]): string[] {
  const left: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const eq = tokens[i].indexOf("=");
    const flag = eq === -1 ? tokens[i] : tokens[i].slice(0, eq);
    let value = eq === -1 ? undefined : tokens[i].slice(eq + 1);
    const spec = tokens[i].startsWith("-") ? flags.get(flag) : undefined;
    if (spec === undefined) {
      left.push(tokens[i]);
      continue;
    }
    // As commander parses: a required value is the next token whatever it is,
    // an optional one is the next token unless that token is a flag.
    if (value === undefined && spec.value === "required") {
      if (i + 1 >= tokens.length) {
        problems.push(`flag ${flag} takes a value and none follows`);
        continue;
      }
      value = tokens[++i];
    } else if (value === undefined && spec.value === "optional" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      value = tokens[++i];
    }
    if (value !== undefined && spec.range !== undefined) {
      const { min, max } = spec.range;
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        problems.push(`flag ${flag} value "${value}" is not a whole number from ${min} to ${max}, as its help states`);
      }
    }
  }
  return left;
}

function problemsIn(command: string, rootFlags: Map<string, FlagSpec>): string[] {
  const m = command.match(/^(?:npx\s+)?ai-trust(?:\s+(.*))?$/);
  if (!m) return ["not an ai-trust command"];
  const problems: string[] = [];
  // Commander parses in two passes. The root program first takes its own flags,
  // with their values, from anywhere in the arguments; help it leaves to the
  // subcommand. So in `check --type --json <name>`, --type takes <name>.
  const ownRootFlags = new Map([...rootFlags].filter(([name]) => name !== "-h" && name !== "--help"));
  const tokens = takeFlags(
    (m[1] ?? "").split(/\s+/).filter((t) => t.length > 0),
    ownRootFlags,
    problems,
  );
  // A first token left that is not a flag is the subcommand; `ai-trust --version` has none.
  const sub = tokens.length > 0 && !tokens[0].startsWith("-") ? tokens.shift() : undefined;
  let flags = rootFlags;
  let usage = "Usage: ai-trust [options]";
  if (sub !== undefined) {
    const subHelp = help([sub]);
    usage = subHelp.stdout.split("\n")[0] ?? "";
    if (subHelp.status !== 0 || !usage.startsWith(`Usage: ai-trust ${sub} `)) {
      return [`unregistered subcommand ${sub}`];
    }
    flags = registeredFlags(subHelp.stdout);
  }
  // The second pass: the subcommand parses what is left.
  let operands = 0;
  for (const token of takeFlags(tokens, flags, problems)) {
    if (token.startsWith("-")) problems.push(`unregistered flag ${token.split("=")[0]}`);
    else operands++;
  }
  const { min, max } = arity(usage);
  if (operands < min || operands > max) {
    problems.push(`${operands} argument(s), "${usage}" takes ${min === max ? min : `${min} to ${max}`}`);
  }
  return problems;
}

describe("tapes type only registered ai-trust commands and flags", () => {
  const all = tapes(join(ROOT, "docs"));

  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("there is a tape, and each one types a command on screen", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const tape of all) {
      expect(typedOnScreen(tape), relative(ROOT, tape)).not.toEqual([]);
    }
  });

  it("each typed command parses against the CLI's own help", () => {
    const rootFlags = registeredFlags(help([]).stdout);
    expect(rootFlags.has("--json")).toBe(true);
    const problems: string[] = [];
    for (const tape of all) {
      for (const command of typedOnScreen(tape)) {
        for (const problem of problemsIn(command, rootFlags)) {
          problems.push(`${relative(ROOT, tape)}: ${problem} in "${command}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 60000);

  it("reports a flag typed without its value, or with a value outside the range its help states", () => {
    const rootFlags = registeredFlags(help([]).stdout);
    expect(registeredFlags(help(["audit"]).stdout).get("--min-trust")).toEqual({
      value: "required",
      range: { min: 0, max: 4 },
    });
    // The CLI exits 1 on each of these three.
    expect(problemsIn("npx ai-trust audit package.json --min-trust", rootFlags)).toEqual([
      "flag --min-trust takes a value and none follows",
    ]);
    expect(problemsIn("npx ai-trust audit package.json --min-trust banana", rootFlags)).toEqual([
      'flag --min-trust value "banana" is not a whole number from 0 to 4, as its help states',
    ]);
    expect(problemsIn("npx ai-trust batch a b --min-trust=5", rootFlags)).toEqual([
      'flag --min-trust value "5" is not a whole number from 0 to 4, as its help states',
    ]);
    expect(problemsIn("npx ai-trust audit package.json --min-trust 3", rootFlags)).toEqual([]);
    expect(problemsIn("npx ai-trust audit --min-trust=0 package.json", rootFlags)).toEqual([]);
  }, 60000);

  it("parses root options first, wherever they stand, as the CLI does", () => {
    const rootFlags = registeredFlags(help([]).stdout);
    // The CLI exits 1 on these two: the root takes --json and --no-color, so
    // --type takes the package name in the first and no value in the second.
    expect(
      problemsIn("npx ai-trust check --type --json @modelcontextprotocol/server-filesystem --no-scan", rootFlags),
    ).toEqual(['0 argument(s), "Usage: ai-trust check [options] <name>" takes 1']);
    expect(problemsIn("npx ai-trust check @modelcontextprotocol/server-filesystem --type --no-color", rootFlags)).toEqual([
      "flag --type takes a value and none follows",
    ]);
    // The CLI runs check on this one: root options may come before the subcommand.
    expect(
      problemsIn(
        "npx ai-trust --registry-url http://127.0.0.1:9 --json check @modelcontextprotocol/server-filesystem --no-scan",
        rootFlags,
      ),
    ).toEqual([]);
  }, 60000);
});
