/**
 * ai-trust does not speak in another tool's voice.
 *
 * scripts/foreign-voice.mjs reports two shapes: a command of another OpenA2A
 * CLI cited the way that CLI cites itself (`hackmyagent check express`)
 * instead of the `npx <package>` form ai-trust uses, and the running tool
 * named as a separate CLI. This suite holds the rule on planted lines and on
 * lines ai-trust prints, then applies it to every string literal in the
 * non-test source under src/ and to the output of both library paths of
 * `check`. src/docs-examples.test.ts applies it to the output of every
 * command the docs run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { describeFinding, foreignVoice } from "../scripts/foreign-voice.mjs";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

describe("the foreign-voice rule", () => {
  it("reports another CLI's command in its own form, and the running tool named as a separate CLI", () => {
    const planted = [
      "  For a thorough security audit:",
      "    hackmyagent check express",
      "Run: opena2a protect .",
      "  ai-trust is a separate CLI — install with: npm i -g ai-trust",
      "  → Re-verify  npx opena2a review",
      "No analyzable surfaces. Use `secretless-ai scan` first.",
      '    "hackmyagent secure node_modules/x --details"',
    ].join("\n");

    expect(foreignVoice(planted).map((f) => describeFinding("planted", f))).toEqual([
      `planted:2: bare-command: "hackmyagent check"; ai-trust's form is "npx hackmyagent check" (hackmyagent check express)`,
      `planted:3: bare-command: "opena2a protect"; ai-trust's form is "npx opena2a-cli protect" (Run: opena2a protect .)`,
      `planted:4: self-as-other: "ai-trust is a separate CLI" (ai-trust is a separate CLI — install with: npm i -g ai-trust)`,
      `planted:5: bare-command: "npx opena2a review"; ai-trust's form is "npx opena2a-cli review" (→ Re-verify  npx opena2a review)`,
      `planted:6: bare-command: "secretless-ai scan"; ai-trust's form is "npx secretless-ai scan" (No analyzable surfaces. Use \`secretless-ai scan\` first.)`,
      `planted:7: bare-command: "hackmyagent secure"; ai-trust's form is "npx hackmyagent secure" ("hackmyagent secure node_modules/x --details")`,
    ]);
  });

  it("passes the lines ai-trust prints that name another tool or its own commands", () => {
    const printed = [
      "  Library security:  npx hackmyagent secure .",
      "  General security scan: npx hackmyagent secure .",
      "Run `npx hackmyagent secure --fix` to auto-remediate where possible, then rescan.",
      "Community contribution enabled for ai-trust, hackmyagent and opena2a-cli.",
      "  ai-trust is for AI packages. For general security, use HackMyAgent.",
      "  → Fresh scan  ai-trust check @modelcontextprotocol/server-filesystem",
      "  toggle: 'ai-trust telemetry on'  or  OPENA2A_TELEMETRY=on",
      "npm install -g ai-trust",
      "hackmyagent is the scanner ai-trust runs for a local scan.",
    ].join("\n");

    expect(foreignVoice(printed)).toEqual([]);
  });

  it("judges by the tool that prints: a CLI may cite itself bare, and the seed footer is foreign inside opena2a", () => {
    expect(foreignVoice("Run: hackmyagent secure .", { self: "hackmyagent" })).toEqual([]);
    const footer = "  opena2a is a separate CLI — install with: npm i -g opena2a-cli";
    expect(foreignVoice(footer)).toEqual([]);
    expect(foreignVoice(footer, { self: "opena2a" }).map((f) => f.rule)).toEqual(["self-as-other"]);
  });
});

/** The non-test TypeScript files under src/. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
    }
  };
  walk(join(ROOT, "src"));
  return out.sort();
}

/** Each string literal and template text of `file`, with the line it starts on. */
function literals(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("the strings in src/", () => {
  it("cite no other CLI's command in that CLI's own form", () => {
    const files = sourceFiles();
    const found: string[] = [];
    let count = 0;
    for (const file of files) {
      for (const literal of literals(file)) {
        count++;
        for (const f of foreignVoice(literal.text)) {
          found.push(describeFinding(relative(ROOT, file), { ...f, line: literal.line + f.line - 1 }));
        }
      }
    }
    expect(files.length).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});

// A registry that answers for one registry-classified library (chalk); every
// other name is not found, so express reaches the name-only library path.
const LIBRARY_ANSWER = {
  packageId: "00000000-0000-0000-0000-000000000001",
  name: "chalk",
  packageType: "library",
  trustLevel: 3,
  trustScore: 0.8,
  verdict: "passed",
  scanStatus: "passed",
  communityScans: 1,
};

let server: Server;
let registryUrl: string;
let scratch: string;

function startRegistry(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const found = req.method === "GET" && url.pathname === "/api/v1/trust/query" && url.searchParams.get("name") === "chalk";
    res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(found ? LIBRARY_ANSWER : { error: "package not found" }));
  });
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done(srv)));
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: scratch,
    NO_COLOR: "1",
    CI: "true",
    OPENA2A_TELEMETRY: "off",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return new Promise((done, reject) => {
    // Async spawn, not spawnSync: the fixture registry runs in this process.
    const child = spawn(process.execPath, [CLI_PATH, ...args, "--registry-url", registryUrl], {
      cwd: scratch,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-voice-"));
  server = await startRegistry();
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("check on a library points to hackmyagent in the npx form", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  for (const name of ["chalk", "express"]) {
    it(`check ${name} --no-scan`, async () => {
      const { status, stdout, stderr } = await runCli(["check", name, "--no-scan"]);
      expect(status).toBe(0);
      expect(stderr).toContain(`    npx hackmyagent check ${name}\n`);
      expect([...foreignVoice(stdout), ...foreignVoice(stderr)]).toEqual([]);
    }, 30000);

    it(`check ${name} --no-scan --json`, async () => {
      const { status, stdout } = await runCli(["check", name, "--no-scan", "--json"]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).nextSteps).toEqual([`npx hackmyagent check ${name}`]);
      expect(foreignVoice(stdout)).toEqual([]);
    }, 30000);
  }
});
