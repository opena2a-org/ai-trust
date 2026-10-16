/**
 * ai-trust does not speak in another tool's voice.
 *
 * scripts/foreign-voice.mjs reports two shapes: a command of another OpenA2A
 * CLI cited the way that CLI cites itself (`hackmyagent check express`)
 * instead of the `npx <package>` form ai-trust uses, and the running tool
 * named as a separate CLI. This suite holds the rule on planted lines and on
 * lines ai-trust prints, then applies it to every string literal in the
 * non-test source under src/, to the Fix lines of a local scan, to the output
 * of both library paths of `check`, and to the commands a registry narrative
 * sends to `check mcp:`.
 * src/docs-examples.test.ts applies it to the output of every command the
 * docs run.
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
import { formatScanResult } from "./output/formatter.js";
import type { ScanResult } from "./scanner/index.js";

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

// Fix text in the forms the bundled scanner sends: each names an OpenA2A CLI
// by its command, at the start of the text or inside a sentence.
const SCANNER_FIXES = [
  "opena2a protect . — migrates hardcoded secrets into the Secretless vault (local, keychain, 1Password, or HashiCorp Vault). Keys are injected at runtime; source files reference them by name only.",
  "opena2a protect .  — scans for hardcoded secrets and encrypts them into a secure vault. Remove credentials from instruction files — they are sent to the AI provider on every request.",
  "opena2a protect . — encrypts the API key into a secure vault and injects it at runtime",
  "npx secretless-ai init",
  "hackmyagent secure --fix",
  "hackmyagent harden-soul .  — generates SOUL.md with required constraint sections",
  "Add a SOUL.md or system prompt with safety boundaries. Run: hackmyagent scan-soul to generate one.",
  "hackmyagent rollback",
  "docker exec <sandbox-container> npx hackmyagent scan --ci /app",
];

describe("the Fix lines of a local scan", () => {
  it("cite the scanner's commands in the npx form", () => {
    const result: ScanResult = {
      packageName: "demo",
      trustScore: 0.4,
      trustLevel: 1,
      verdict: "warning",
      scan: {
        score: 40,
        maxScore: 100,
        checksEvaluated: 30,
        findings: SCANNER_FIXES.map((fix, i) => ({
          checkId: `DEMO-${i + 1}`,
          name: `Demo finding ${i + 1}`,
          description: "demo",
          category: "demo",
          severity: "high",
          passed: false,
          message: "demo",
          fix,
        })),
        projectType: "library",
        timestamp: "2026-01-01T00:00:00Z",
      },
    };
    const output = formatScanResult(result).replace(/\x1b\[[0-9;]*m/g, "");
    expect(output.split("\n").filter((line) => line.includes("Fix: "))).toHaveLength(SCANNER_FIXES.length);
    expect(foreignVoice(output).map((f) => describeFinding("Fix lines", f))).toEqual([]);
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

// A narrative for demo-mcp whose commands cite the other CLIs in their own
// forms, next to one in ai-trust's form and one of ai-trust's own commands.
const NARRATIVE = {
  artifactType: "mcp",
  packageName: "demo-mcp",
  packageVersion: "1.0.0",
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00Z",
  summary: "demo",
  hardcodedSecrets: {
    scanCovered: true,
    detected: [
      {
        type: "demo_token",
        typeLabel: "Demo token",
        file: "src/index.js",
        line: 3,
        maskedValue: "FAKE****",
        shownChars: 4,
        totalChars: 12,
        shipsInArtifact: true,
        severity: "high",
        rotationCommand: "secretless-ai scan .",
      },
    ],
  },
  mcp: { mcpName: "demo-mcp", tools: [], pathScope: "", network: "", persistence: "", auth: "", sideEffects: [] },
  verdictReasoning: [],
  nextSteps: [
    { weight: "primary", label: "Scan locally", command: "hackmyagent check mcp:demo-mcp" },
    { weight: "secondary", label: "Protect", command: "opena2a protect ." },
    { weight: "secondary", label: "Review", command: "npx opena2a review" },
    { weight: "secondary", label: "Harden", command: "npx hackmyagent secure ." },
    { weight: "secondary", label: "Recheck", command: "ai-trust check mcp:demo-mcp" },
  ],
};

let server: Server;
let registryUrl: string;
let scratch: string;

function startRegistry(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const name = url.searchParams.get("name");
    if (req.method === "GET" && url.pathname === "/api/v1/trust/narrative" && name === "demo-mcp") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(NARRATIVE));
      return;
    }
    const found = req.method === "GET" && url.pathname === "/api/v1/trust/query" && name === "chalk";
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

describe("check mcp:<name> prints the commands the registry sends in the npx form", () => {
  it("check mcp:demo-mcp", async () => {
    const { status, stdout, stderr } = await runCli(["check", "mcp:demo-mcp"]);
    expect(status).toBe(0);
    const printed = stdout.split("\n").map((l) => l.trim().replace(/: +/, ": "));
    expect(printed).toEqual(
      expect.arrayContaining([
        "Scan locally: npx hackmyagent check mcp:demo-mcp",
        "Protect: npx opena2a-cli protect .",
        "Review: npx opena2a-cli review",
        "Harden: npx hackmyagent secure .",
        "Recheck: ai-trust check mcp:demo-mcp",
        "Rotate (Demo token): npx secretless-ai scan .",
      ]),
    );
    expect([...foreignVoice(stdout), ...foreignVoice(stderr)]).toEqual([]);
  }, 30000);

  it("check mcp:demo-mcp --json carries them as the registry sent them", async () => {
    const { status, stdout } = await runCli(["check", "mcp:demo-mcp", "--json"]);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.nextSteps.map((s: { command: string }) => s.command)).toEqual(
      NARRATIVE.nextSteps.map((s) => s.command),
    );
    expect(json.hardcodedSecrets.detected[0].rotationCommand).toBe("secretless-ai scan .");
  }, 30000);
});
