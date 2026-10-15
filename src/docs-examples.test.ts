/**
 * The ai-trust commands the docs show in shell blocks are run, or carry the
 * reason they are not.
 *
 * docs/examples.json lists every line of a shell block in README.md,
 * CONTRIBUTING.md and the Markdown under docs/ that runs ai-trust (the release
 * checklist under docs/testing/ is left out: a maintainer runs it by hand
 * against the public registry). Each line is in one of two lists:
 *
 * - "run": this suite runs the command with the built dist/index.js against
 *   a local registry that serves docs/demo/registry-fixture.json, in a fresh
 *   HOME, and fails unless it exits with the listed code. The command runs in
 *   an empty directory, or in the listed `cwd`.
 * - "noexec": not run; the value says why (most download a package from npm
 *   and scan it).
 *
 * The suite also fails when a cited line is in neither list, when an entry
 * matches no cited line, when a line is in both lists, when a run asks the
 * registry for anything the fixture does not serve, and when a run prints a
 * line in another tool's voice (scripts/foreign-voice.mjs).
 *
 * Each run gets OPENA2A_TELEMETRY=off, which turns usage telemetry off, and an
 * npm registry address on a closed local port, so a command that tries to
 * download a package fails instead of reaching npm (a test below holds this).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describeFinding, foreignVoice } from "../scripts/foreign-voice.mjs";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");
const MANIFEST = "docs/examples.json";
const NULL_UUID = "00000000-0000-0000-0000-000000000000";
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);
// A shell segment that runs ai-trust, after any VAR=value prefix.
const PROGRAM = /^(?:npx\s+)?(?:ai-trust|node\s+dist\/index\.js|\$AI)(?:\s+(.*))?$/;
// A run entry is one plain ai-trust command: no pipe, list, substitution,
// redirect, quote or variable, so its words are its arguments.
const PLAIN = /^(?:npx\s+)?(?:ai-trust|node\s+dist\/index\.js)(?:\s+[^\s|&;$'"`\\<>()]+)+$/;

interface RunEntry {
  exit: number;
  cwd?: string;
  /** Why the run exits as it does on the fixture; not read by the runner. */
  note?: string;
}

interface Manifest {
  run: Record<string, RunEntry>;
  noexec: Record<string, string>;
}

interface Citation {
  doc: string;
  line: number;
  command: string;
}

interface RegistryFixture {
  query: Record<string, unknown>;
  batch: Array<{ name: string }>;
}

/** README.md, CONTRIBUTING.md and the Markdown under docs/, leaving out docs/testing/. */
function docFiles(): string[] {
  const out = ["README.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(ROOT, f)));
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path !== "docs/testing") walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(path);
      }
    }
  };
  walk("docs");
  return out.sort();
}

function runsAiTrust(command: string): boolean {
  return command
    .split(/\|\||&&|\||;|\$\(/)
    .some((segment) => PROGRAM.test(segment.trim().replace(/^(?:\w+=\S*\s+)+/, "")));
}

/** Lines of the shell blocks in `markdown` that run ai-trust, a trailing `# comment` removed. */
function citations(doc: string, markdown: string): Citation[] {
  const out: Citation[] = [];
  let lang: string | null = null;
  markdown.split("\n").forEach((text, i) => {
    if (lang === null) {
      const open = /^```([^`]*)$/.exec(text);
      if (open) lang = open[1].trim().toLowerCase();
      return;
    }
    if (/^```[ \t]*$/.test(text)) {
      lang = null;
      return;
    }
    if (!SHELL_LANGS.has(lang)) return;
    const command = text.replace(/\s+#.*$/, "").trim();
    if (command === "" || command.startsWith("#")) return;
    if (runsAiTrust(command)) out.push({ doc, line: i + 1, command });
  });
  return out;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8")) as Manifest;
}

/** Disagreements between the cited lines and the manifest. */
function manifestProblems(cited: Citation[], manifest: Manifest): string[] {
  const problems: string[] = [];
  const run = manifest.run ?? {};
  const noexec = manifest.noexec ?? {};
  for (const c of cited) {
    if (!(c.command in run) && !(c.command in noexec)) {
      problems.push(`${c.doc}:${c.line}: "${c.command}" is in neither "run" nor "noexec" of ${MANIFEST}`);
    }
  }
  const citedCommands = new Set(cited.map((c) => c.command));
  for (const command of [...Object.keys(run), ...Object.keys(noexec)]) {
    if (!citedCommands.has(command)) {
      problems.push(`${MANIFEST}: "${command}" matches no line in a shell block of the docs`);
    }
  }
  for (const [command, entry] of Object.entries(run)) {
    if (command in noexec) problems.push(`${MANIFEST}: "${command}" is in both "run" and "noexec"`);
    if (!PLAIN.test(command)) {
      problems.push(`${MANIFEST}: "${command}" is in "run" but is not one plain ai-trust command`);
    } else if (/(?:^|\s)--registry-url(?:\s|=|$)/.test(command)) {
      problems.push(`${MANIFEST}: "${command}" is in "run" but names its own registry`);
    }
    if (!Number.isInteger(entry.exit)) problems.push(`${MANIFEST}: "${command}" has no integer exit code`);
    if (entry.cwd !== undefined && !existsSync(join(ROOT, entry.cwd))) {
      problems.push(`${MANIFEST}: "${command}" runs in ${entry.cwd}, which does not exist`);
    }
  }
  for (const [command, reason] of Object.entries(noexec)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      problems.push(`${MANIFEST}: "${command}" is in "noexec" with no reason`);
    }
  }
  return problems;
}

const FIXTURE: RegistryFixture = JSON.parse(
  readFileSync(join(ROOT, "docs/demo/registry-fixture.json"), "utf8"),
);

let server: Server;
let registryUrl: string;
let scratch: string;
let unexpected: string[] = [];

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
    unexpected.push(`${req.method} ${url.pathname}`);
    send(404, { error: "unexpected request" });
  });
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done(srv)));
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one plain ai-trust command with the built CLI against the fixture registry. */
function runExample(command: string, entry: RunEntry): Promise<RunResult> {
  const args = (PROGRAM.exec(command)?.[1] ?? "").split(/\s+/).filter((w) => w.length > 0);
  const home = mkdtempSync(join(scratch, "home-"));
  let cwd = join(ROOT, entry.cwd ?? "");
  if (entry.cwd === undefined) {
    cwd = join(home, "cwd");
    mkdirSync(cwd);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    NO_COLOR: "1",
    CI: "true",
    OPENA2A_TELEMETRY: "off",
    // Port 1 refuses the connection: a download fails at once and reaches nothing.
    npm_config_registry: "http://127.0.0.1:1/",
    npm_config_fetch_retries: "0",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return new Promise((done, reject) => {
    // Async spawn, not spawnSync: the fixture registry runs in this process.
    const child = spawn(process.execPath, [CLI_PATH, ...args, "--registry-url", registryUrl], {
      cwd,
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

/** The lines of a run's output written in another tool's voice. */
function voiceProblems(command: string, stdout: string, stderr: string): string[] {
  return [
    ...foreignVoice(stdout).map((f) => `"${command}" printed ${describeFinding("stdout", f)}`),
    ...foreignVoice(stderr).map((f) => `"${command}" printed ${describeFinding("stderr", f)}`),
  ];
}

/**
 * What is wrong with one run: a different exit code, a request the fixture
 * does not serve, or a line in another tool's voice.
 */
async function runProblems(command: string, entry: RunEntry): Promise<string[]> {
  unexpected = [];
  const { status, stdout, stderr } = await runExample(command, entry);
  const problems: string[] = [];
  if (status !== entry.exit) {
    const tail = (stderr + stdout).trim().split("\n").slice(-3).join(" | ");
    problems.push(`"${command}" exited ${status}, ${MANIFEST} says ${entry.exit}: ${tail}`);
  }
  for (const request of unexpected) {
    problems.push(`"${command}" asked the registry for ${request}, which the fixture does not serve`);
  }
  problems.push(...voiceProblems(command, stdout, stderr));
  return problems;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-examples-"));
  server = await startRegistry();
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("the walker finds the ai-trust commands in shell blocks", () => {
  const markdown = [
    "# Planted",
    "```bash",
    "npx ai-trust check planted-package --no-scan",
    "# ai-trust check commented-out",
    "npm install -g ai-trust",
    "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')  # in a script",
    "```",
    "```",
    "ai-trust check output-block-line",
    "```",
    "```sh",
    "opena2a registry planted-package",
    "```",
  ].join("\n");

  it("names each cited line with its file and line number", () => {
    expect(citations("planted.md", markdown)).toEqual([
      { doc: "planted.md", line: 3, command: "npx ai-trust check planted-package --no-scan" },
      {
        doc: "planted.md",
        line: 6,
        command: "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')",
      },
    ]);
  });

  it("reports a cited line the manifest does not list, and an entry no doc cites", () => {
    const manifest: Manifest = {
      run: { "ai-trust check stale-entry --no-scan": { exit: 0 } },
      noexec: {
        "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')": "A script line.",
      },
    };
    expect(manifestProblems(citations("planted.md", markdown), manifest)).toEqual([
      `planted.md:3: "npx ai-trust check planted-package --no-scan" is in neither "run" nor "noexec" of ${MANIFEST}`,
      `${MANIFEST}: "ai-trust check stale-entry --no-scan" matches no line in a shell block of the docs`,
    ]);
  });

  it("refuses a run entry that is not one plain command, names a registry, or also has a reason", () => {
    const cited: Citation[] = [
      "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')",
      "ai-trust check planted-package --registry-url http://localhost:8080",
      "ai-trust batch planted-package",
      "ai-trust audit package.json",
    ].map((command, i) => ({ doc: "planted.md", line: i + 1, command }));
    const manifest: Manifest = {
      run: {
        "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')": { exit: 0 },
        "ai-trust check planted-package --registry-url http://localhost:8080": { exit: 0 },
        "ai-trust batch planted-package": { exit: 0 },
        "ai-trust audit package.json": { exit: 0, cwd: "docs/no-such-dir" },
      },
      noexec: { "ai-trust batch planted-package": " " },
    };
    expect(manifestProblems(cited, manifest)).toEqual([
      `${MANIFEST}: "TRUST=$(npx ai-trust check planted-package --json | jq '.trustLevel')" is in "run" but is not one plain ai-trust command`,
      `${MANIFEST}: "ai-trust check planted-package --registry-url http://localhost:8080" is in "run" but names its own registry`,
      `${MANIFEST}: "ai-trust batch planted-package" is in both "run" and "noexec"`,
      `${MANIFEST}: "ai-trust audit package.json" runs in docs/no-such-dir, which does not exist`,
      `${MANIFEST}: "ai-trust batch planted-package" is in "noexec" with no reason`,
    ]);
  });

  it("reports a run whose exit code differs from the manifest", async () => {
    // The fixture registry has no answer for this name, so `check --no-scan` exits 2.
    const problems = await runProblems("ai-trust check planted-package --no-scan", { exit: 0 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^"ai-trust check planted-package --no-scan" exited 2, docs\/examples\.json says 0: /);
  }, 30000);

  it("reports a run that prints another tool's command in that tool's own form", () => {
    const stdout = ["", "  Out of scope for ai-trust", "  For a thorough security audit:", "    hackmyagent check express", ""].join("\n");
    const stderr = "Run: opena2a protect .\n";
    expect(voiceProblems("ai-trust check express --no-scan", stdout, stderr)).toEqual([
      `"ai-trust check express --no-scan" printed stdout:4: bare-command: "hackmyagent check"; ai-trust's form is "npx hackmyagent check" (hackmyagent check express)`,
      `"ai-trust check express --no-scan" printed stderr:1: bare-command: "opena2a protect"; ai-trust's form is "npx opena2a-cli protect" (Run: opena2a protect .)`,
    ]);
  });

  it("a command that downloads a package fails on the closed npm port instead of reaching npm", async () => {
    // Without --no-scan, check downloads the package with `npm pack`.
    const { status, stderr } = await runExample("ai-trust check @modelcontextprotocol/server-filesystem", {
      exit: 1,
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/Failed to download "@modelcontextprotocol\/server-filesystem": code ECONNREFUSED/);
  }, 30000);
});

describe(`every ai-trust command in the docs' shell blocks is in ${MANIFEST}`, () => {
  const docs = docFiles();
  const cited = docs.flatMap((doc) => citations(doc, readFileSync(join(ROOT, doc), "utf8")));
  const manifest = loadManifest();

  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("the docs cite ai-trust commands, and each cited line has exactly one entry", () => {
    expect(cited.length).toBeGreaterThan(0);
    expect(manifestProblems(cited, manifest)).toEqual([]);
  });

  for (const [command, entry] of Object.entries(manifest.run ?? {})) {
    it(`runs: ${command} (exit ${entry.exit}${entry.cwd ? `, in ${entry.cwd}` : ""})`, async () => {
      expect(await runProblems(command, entry)).toEqual([]);
    }, 30000);
  }
});
