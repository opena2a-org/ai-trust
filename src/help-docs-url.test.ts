/**
 * Each `--help` names the documentation URL once, on its last line.
 *
 * Walks the built `dist/index.js`: the root help, the help printed with no
 * arguments and by `help`, and the help of every subcommand listed under
 * "Commands:", recursively (so `config contribute` is covered). Each must end
 * with one blank line and then `Documentation: <DOCS_URL>`, and print no
 * other URL apart from the registry API default of `--registry-url`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { DOCS_URL, helpDocsLine } from "./utils/help-docs.js";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const REGISTRY_API_DEFAULT = "https://api.oa2a.org";
const DOCS_LINE = `Documentation: ${DOCS_URL}`;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-help-docs-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function help(args: string[]): string {
  const run = spawnSync(process.execPath, [CLI_PATH, ...args], {
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
    timeout: 20000,
  });
  expect(run.status, `ai-trust ${args.join(" ")} exit code`).toBe(0);
  return (run.stdout ?? "").replace(STRIP_ANSI, "");
}

/** Subcommand names listed under "Commands:", without the built-in `help`. */
function subcommands(helpText: string): string[] {
  const names: string[] = [];
  for (const line of (helpText.split(/^Commands:\n/m)[1] ?? "").split("\n")) {
    if (line.trim() === "") break;
    const m = line.match(/^  (\S+)/);
    if (m && m[1] !== "help") names.push(m[1]);
  }
  return names;
}

/** Every command path reachable from the root help, root first. */
function commandPaths(): string[][] {
  const paths: string[][] = [];
  const queue: string[][] = [[]];
  while (queue.length > 0) {
    const path = queue.shift()!;
    paths.push(path);
    for (const name of subcommands(help([...path, "--help"]))) queue.push([...path, name]);
  }
  return paths;
}

/** Problems with the documentation line in one help text. */
function docsLineProblems(helpText: string): string[] {
  const problems: string[] = [];
  const lines = helpText.replace(/\n+$/, "").split("\n");
  const docsLines = lines.filter((l) => l.startsWith("Documentation:"));
  if (docsLines.length !== 1) problems.push(`${docsLines.length} Documentation lines`);
  if (lines[lines.length - 1] !== DOCS_LINE) problems.push(`last line is "${lines[lines.length - 1]}"`);
  if (lines[lines.length - 2] !== "" || lines[lines.length - 3] === "") {
    problems.push("the Documentation line does not follow exactly one blank line");
  }
  const urls = (helpText.match(/https?:\/\/[^\s"')]+/g) ?? []).filter((u) => u !== REGISTRY_API_DEFAULT);
  if (urls.length !== 1 || urls[0] !== DOCS_URL) problems.push(`URLs other than the registry API: ${urls.join(", ")}`);
  return problems;
}

describe("--help names the documentation URL", { timeout: 120000 }, () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("covers config contribute and telemetry among the walked commands", () => {
    if (!existsSync(CLI_PATH)) return;
    const walked = commandPaths().map((p) => p.join(" "));
    expect(walked).toEqual(expect.arrayContaining(["", "check", "audit", "batch", "config", "config contribute", "telemetry"]));
  });

  it("ends every help with one Documentation line and prints no other docs URL", () => {
    if (!existsSync(CLI_PATH)) return;
    const problems: string[] = [];
    for (const path of commandPaths()) {
      for (const p of docsLineProblems(help([...path, "--help"]))) {
        problems.push(`ai-trust ${[...path, "--help"].join(" ")}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(["", "help", "help check"])("ends the help printed by `ai-trust %s` the same way", (line) => {
    if (!existsSync(CLI_PATH)) return;
    expect(docsLineProblems(help(line.split(" ").filter(Boolean)))).toEqual([]);
  });
});

describe("helpDocsLine", () => {
  it("is a page of the documentation site, not a repository root", () => {
    const url = new URL(DOCS_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("opena2a.org");
    expect(url.pathname).toBe("/docs/ai-trust");
  });

  it("adds the separating blank line only when the command has no help text after its own", () => {
    const bare = new Command("bare");
    expect(helpDocsLine(bare)).toBe(`\n${DOCS_LINE}`);

    const withExamples = new Command("examples");
    withExamples.addHelpText("after", "\nExamples:\n  ai-trust examples\n");
    expect(helpDocsLine(withExamples)).toBe(DOCS_LINE);
  });
});
