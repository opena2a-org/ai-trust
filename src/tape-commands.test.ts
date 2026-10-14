/**
 * Recorded commands are commands the CLI registers.
 *
 * A recording is rendered from a VHS tape under docs/. Every command a tape
 * types on screen (a `Type` line outside a `Hide`..`Show` block) must be an
 * `ai-trust` command that names a registered subcommand, uses only flags that
 * subcommand or the root command registers, and passes as many arguments as
 * the subcommand takes. The check asks the built CLI itself, through
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

/** Flags listed under "Options:" in a help text, mapped to whether they take a value. */
function registeredFlags(helpText: string): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const line of helpText.split("\n")) {
    const m = line.match(/^ {2}((?:-\w|--[\w-]+)(?:, (?:-\w|--[\w-]+))*)( [<[]\S+)?/);
    if (!m) continue;
    for (const flag of m[1].split(", ")) flags.set(flag, m[2] !== undefined);
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

function problemsIn(command: string, rootFlags: Map<string, boolean>): string[] {
  const m = command.match(/^(?:npx\s+)?ai-trust(?:\s+(.*))?$/);
  if (!m) return ["not an ai-trust command"];
  const tokens = (m[1] ?? "").split(/\s+/).filter((t) => t.length > 0);
  // A first token that is not a flag is the subcommand; `ai-trust --version` has none.
  const sub = tokens.length > 0 && !tokens[0].startsWith("-") ? tokens.shift() : undefined;
  let flags = rootFlags;
  let usage = "Usage: ai-trust [options]";
  if (sub !== undefined) {
    const subHelp = help([sub]);
    usage = subHelp.stdout.split("\n")[0] ?? "";
    if (subHelp.status !== 0 || !usage.startsWith(`Usage: ai-trust ${sub} `)) {
      return [`unregistered subcommand ${sub}`];
    }
    flags = new Map([...rootFlags, ...registeredFlags(subHelp.stdout)]);
  }
  const problems: string[] = [];
  let operands = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith("-")) {
      operands++;
      continue;
    }
    const [flag, inlineValue] = tokens[i].split("=", 2);
    if (!flags.has(flag)) problems.push(`unregistered flag ${flag}`);
    else if (flags.get(flag) && inlineValue === undefined) i++;
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
});
