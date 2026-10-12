/**
 * Docs samples match what the CLI prints (#99).
 *
 * Every output sample in README.md and docs/ is produced by a command shown
 * right above it. This suite runs each of those commands with the built
 * `dist/index.js` against a local registry that serves the answers in
 * docs/demo/registry-fixture.json, and compares the output structure with
 * the sample. Digits are normalized (scores, scan ages and column widths
 * drift with registry data); labels, sections, line order and wording are
 * not. When the CLI output format changes, regenerate the samples:
 *
 *   node dist/index.js check @modelcontextprotocol/server-filesystem --no-scan
 *   (cd docs/demo && node ../../dist/index.js audit package.json)
 *
 * Two guards keep the docs honest beyond the listed samples:
 * - every output block in the docs must be claimed by an entry in SAMPLES, so
 *   a new hand-written sample cannot land unverified;
 * - every `ai-trust` command cited in a shell block must use a registered
 *   subcommand and registered flags.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");
const DEMO_DIR = join(ROOT, "docs/demo");
const NULL_UUID = "00000000-0000-0000-0000-000000000000";
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

interface RegistryFixture {
  query: Record<string, unknown>;
  batch: Array<{ name: string }>;
}

const FIXTURE: RegistryFixture = JSON.parse(
  readFileSync(join(DEMO_DIR, "registry-fixture.json"), "utf8"),
);

const DOCS = [
  "README.md",
  "docs/USE-CASES.md",
  ...readdirSync(join(ROOT, "docs/use-cases"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/use-cases/${f}`),
];

interface Sample {
  doc: string;
  /** The command line exactly as it appears in the shell block above the sample. */
  command: string;
  /** Working directory; defaults to an empty scratch directory. */
  cwd?: string;
  /** The sample shows stderr lines (e.g. "Resolved: ...") before stdout. */
  stderr?: boolean;
}

const SAMPLES: Sample[] = [
  {
    doc: "README.md",
    command: "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan",
  },
  { doc: "README.md", command: "ai-trust audit package.json", cwd: DEMO_DIR },
  {
    doc: "docs/use-cases/check-before-install.md",
    command: "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan",
  },
  {
    doc: "docs/use-cases/check-mcp-server.md",
    command: "npx ai-trust check server-filesystem --no-scan",
    stderr: true,
  },
  {
    doc: "docs/use-cases/check-mcp-server.md",
    command: "npx ai-trust check server-filesystem --no-scan --json",
  },
];

interface Fence {
  lang: string;
  body: string;
}

function readDoc(doc: string): string {
  return readFileSync(join(ROOT, doc), "utf8");
}

function fences(markdown: string): Fence[] {
  const out: Fence[] = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    out.push({ lang: m[1].trim().toLowerCase(), body: m[2] });
  }
  return out;
}

function isOutput(f: Fence): boolean {
  return !SHELL_LANGS.has(f.lang);
}

function commandLines(f: Fence): string[] {
  return f.body
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

/** Index of the output fence that directly follows the shell fence holding `command`. */
function sampleIndex(doc: string, command: string): number[] {
  const all = fences(readDoc(doc));
  const hits: number[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    if (isOutput(all[i]) || !isOutput(all[i + 1])) continue;
    if (commandLines(all[i]).includes(command)) hits.push(i + 1);
  }
  return hits;
}

/** Output structure: ANSI stripped, digit runs and whitespace runs collapsed, blank lines dropped. */
function shape(text: string): string[] {
  return text
    .replace(STRIP_ANSI, "")
    .split("\n")
    .map((l) => l.replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

let server: Server;
let registryUrl: string;
let scratch: string;

function startRegistry(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/api/v1/trust/query") {
      const answer = FIXTURE.query[url.searchParams.get("name") ?? ""];
      if (answer === undefined) return send(404, { error: "package not found" });
      return send(200, answer);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/trust/batch") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { packages } = JSON.parse(body) as { packages: Array<{ name: string }> };
        const results = packages.map(
          (p) =>
            FIXTURE.batch.find((r) => r.name === p.name) ?? {
              packageId: NULL_UUID,
              name: p.name,
              trustLevel: 0,
              trustScore: 0,
              verdict: "",
              scanStatus: "",
              communityScans: 0,
            },
        );
        send(200, { queriedAt: new Date().toISOString(), results, total: results.length });
      });
      return;
    }
    send(404, { error: "unexpected request" });
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

function runCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun, reject) => {
    // Minimal environment: no host config, no consent file, no telemetry,
    // no AI_TRUST_CLI_PREFIX leaking in from the machine running the suite.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      NO_COLOR: "1",
      CI: "true",
      OPENA2A_TELEMETRY: "off",
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    // Async spawn, not spawnSync: the fixture registry runs in this process.
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-docs-"));
  server = await startRegistry();
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("docs output samples match the current build", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  for (const sample of SAMPLES) {
    it(`${sample.doc}: ${sample.command}`, async () => {
      const hits = sampleIndex(sample.doc, sample.command);
      expect(hits, "the command needs exactly one output block right after its shell block").toHaveLength(1);
      const expected = fences(readDoc(sample.doc))[hits[0]].body;

      const args = sample.command.replace(/^npx /, "").split(/\s+/).slice(1);
      const { stdout, stderr, status } = await runCli(
        [...args, "--registry-url", registryUrl],
        sample.cwd ?? scratch,
      );
      expect(status).toBe(0);
      const actual = sample.stderr ? stderr + stdout : stdout;
      expect(shape(actual)).toEqual(shape(expected));
    }, 30000);
  }

  it("every output block in the docs is a verified sample", () => {
    const unclaimed: string[] = [];
    for (const doc of DOCS) {
      const claimed = new Set(
        SAMPLES.filter((s) => s.doc === doc).flatMap((s) => sampleIndex(doc, s.command)),
      );
      fences(readDoc(doc)).forEach((f, i) => {
        if (isOutput(f) && !claimed.has(i)) {
          unclaimed.push(`${doc}: ${f.body.split("\n")[0]}`);
        }
      });
    }
    expect(unclaimed).toEqual([]);
  });
});

describe("docs cite only registered ai-trust commands and flags", () => {
  const helpCache = new Map<string, string>();
  async function help(sub?: string): Promise<string> {
    const key = sub ?? "";
    if (!helpCache.has(key)) {
      const { stdout } = await runCli(sub ? [sub, "--help"] : ["--help"], scratch);
      helpCache.set(key, stdout);
    }
    return helpCache.get(key)!;
  }

  /** Subcommand names listed under "Commands:" in the root help. */
  function subcommands(rootHelp: string): Set<string> {
    const names = new Set<string>();
    for (const line of (rootHelp.split(/^Commands:\n/m)[1] ?? "").split("\n")) {
      if (line.trim() === "") break;
      const m = line.match(/^  (\S+)/);
      if (m) names.add(m[1]);
    }
    return names;
  }

  /**
   * Problems in one cited command: `ai-trust <sub> [flags]` (also written
   * `npx ai-trust`, `node dist/index.js` or `$AI`, after any VAR=value
   * prefix). An `inline` citation (a code span in prose) may also leave out
   * the program name, as changelog entries do (`audit --scan-missing`); a
   * span whose first word is not a subcommand is prose or sample output
   * (`ai-trust 0.x.x`), not a command, so only its flags are checked.
   */
  async function citationProblems(where: string, segment: string, inline: boolean): Promise<string[]> {
    const rootHelp = await help();
    const text = segment.trim().replace(/^(?:\w+=\S*\s+)+/, "");
    const prefixed = text.match(/^(?:npx\s+)?(?:ai-trust|node\s+dist\/index\.js|\$AI)(?:\s+(.*))?$/);
    if (!prefixed && !inline) return [];
    const words = prefixed ? (prefixed[1] ?? "") : text;
    const sub = words.split(/\s+/)[0];
    const flagsIn = (s: string) => s.match(/--[a-z][a-z-]*/g) ?? [];
    const registered = (flag: string, helpText: string) =>
      new RegExp(`(^|[\\s,])${flag}\\b(?!-)`, "m").test(helpText);
    const problems: string[] = [];

    if (sub.startsWith("-")) {
      if (!prefixed) return [];
      for (const flag of flagsIn(words)) {
        if (!registered(flag, rootHelp)) problems.push(`${where}: unregistered flag ${flag} in "${segment.trim()}"`);
      }
      return problems;
    }
    if (!subcommands(rootHelp).has(sub)) {
      return prefixed && sub && !inline ? [`${where}: unknown subcommand in "${segment.trim()}"`] : [];
    }
    const subHelp = await help(sub);
    for (const flag of flagsIn(words.slice(sub.length))) {
      if (!registered(flag, subHelp) && !registered(flag, rootHelp)) {
        problems.push(`${where}: unregistered flag ${flag} in "${segment.trim()}"`);
      }
    }
    return problems;
  }

  const segments = (line: string) => line.split(/\|\||&&|\||;|\$\(/);

  /** Commands cited in the shell blocks of `markdown`. */
  async function shellBlockProblems(where: string, markdown: string): Promise<string[]> {
    const problems: string[] = [];
    for (const f of fences(markdown).filter((x) => !isOutput(x))) {
      for (const line of commandLines(f)) {
        for (const segment of segments(line)) {
          problems.push(...(await citationProblems(where, segment, false)));
        }
      }
    }
    return problems;
  }

  /** Commands cited in inline code spans outside the code blocks of `markdown`. */
  async function inlineProblems(where: string, markdown: string): Promise<string[]> {
    const problems: string[] = [];
    const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");
    for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) {
      for (const segment of segments(span)) {
        problems.push(...(await citationProblems(where, segment, true)));
      }
    }
    return problems;
  }

  /** The `## Unreleased` section of CHANGELOG.md. */
  function unreleasedChangelog(): string {
    const text = readDoc("CHANGELOG.md");
    const start = text.search(/^## Unreleased[ \t]*$/m);
    if (start < 0) return "";
    const section = text.slice(start).replace(/^[^\n]*\n/, "");
    const end = section.search(/^## /m);
    return end < 0 ? section : section.slice(0, end);
  }

  it("each cited subcommand and flag appears in the CLI help", async () => {
    const problems: string[] = [];
    for (const doc of DOCS) {
      problems.push(...(await shellBlockProblems(doc, readDoc(doc))));
    }
    expect(problems).toEqual([]);
  }, 60000);

  it("the release checklist cites only registered subcommands and flags", async () => {
    const doc = "docs/testing/release-smoke.md";
    const problems = [
      ...(await shellBlockProblems(doc, readDoc(doc))),
      ...(await inlineProblems(doc, readDoc(doc))),
    ];
    expect(problems).toEqual([]);
  }, 60000);

  it("the Unreleased changelog section cites only registered subcommands and flags", async () => {
    const section = unreleasedChangelog();
    expect(section).toMatch(/^### /m);
    const problems = [
      ...(await shellBlockProblems("CHANGELOG.md (Unreleased)", section)),
      ...(await inlineProblems("CHANGELOG.md (Unreleased)", section)),
    ];
    expect(problems).toEqual([]);
  }, 60000);

  it("flags an option a command rejects when a changelog entry cites it", async () => {
    // `audit` has --scan-missing; --scan-if-missing belongs to `check`.
    const entry = "- `audit --scan-if-missing` now scans; `check --scan-if-missing` is deprecated.";
    expect(await inlineProblems("entry", entry)).toEqual([
      'entry: unregistered flag --scan-if-missing in "audit --scan-if-missing"',
    ]);
  }, 60000);
});
