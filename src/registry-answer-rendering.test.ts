/**
 * Registry answers, fed through the built CLI (#129).
 *
 * Each case serves one registry answer from a local server and runs
 * `dist/index.js` against it, so the reader, the formatter and the command
 * wiring are exercised together:
 *
 * - a control character in a registry string does not reach the terminal in
 *   text output, and `--json` carries the string as received;
 * - a security profile is read one field at a time;
 * - "No known issues" is not the headline over a `warnings` scan status;
 * - a found package whose scan is in progress shows no score in `batch`;
 * - a found package with a scan date and a scan status that is not a finished
 *   one shows no score in `check --no-scan`, and its Trust line names the
 *   status and the age of the last recorded scan instead of "not scanned";
 * - a trust score off the 0-1 scale shows no score in `batch` and `audit`;
 * - after an HTTP 500 or a body that is not JSON, `audit` names the registry
 *   and a next step, as `batch` does;
 * - a scan status that is not a string shows no score, and a trust level that
 *   is not a whole number shows `-`, in `check --no-scan`, `batch` and
 *   `audit`, which exit with the code `--json` gives (#238);
 * - `check pip:` and `check npm:` are usage errors;
 * - `check pip:<name>` output says pypi, and `check <name> --json` says npm.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
// Any id but the all-zero one, which the registry client reads as "not found".
const PACKAGE_ID = "11111111-1111-4111-8111-111111111111";
// C0 controls other than the line feed that ends each output line, DEL, and
// the C1 controls. The CLI runs with NO_COLOR, so it adds none of its own.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const OSC_TITLE = "\u001b]0;x\u0007";
const RAW_CVE = `CVE-${OSC_TITLE}-1\r\nEXTRA LINE`;
// A body that is not JSON: the JSON parser quotes its first characters in the
// error message the CLI prints.
const BAD_BODY_PACKAGE = "bad-body";
const BAD_BODY = `${OSC_TITLE}<html>`;
// A batch query naming this package is answered with HTTP 500 and a JSON body.
const STATUS_500_PACKAGE = "status-500";
const DAY_MS = 24 * 60 * 60 * 1000;
// An hour past the day boundary, so the age the CLI prints does not depend on the clock.
const SCANNED_231_DAYS_AGO = new Date(Date.now() - 231 * DAY_MS - 60 * 60 * 1000).toISOString();

function answer(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    name,
    packageType: "mcp_server",
    trustLevel: 3,
    trustScore: 0.8,
    verdict: "passed",
    scanStatus: "passed",
    communityScans: 1,
    ...overrides,
  };
}

// The answer in #238's reproduction: listed, level 2, score 0 and a scan date,
// with the field under test given a type the answer does not declare.
function listedAnswer(name: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return answer(name, {
    trustLevel: 2,
    trustScore: 0,
    verdict: "listed",
    lastScannedAt: SCANNED_231_DAYS_AGO,
    ...overrides,
  });
}

const QUERY: Record<string, Record<string, unknown>> = {
  "cve-ctrl": answer("cve-ctrl", {
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: [RAW_CVE] },
  }),
  "cve-clean": answer("cve-clean", {
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: ["CVE-2025-0001"] },
  }),
  "name-ctrl": answer(`name${OSC_TITLE}-ctrl\r\nSECOND LINE`, {
    packageType: "mcp_server\u001b[2J",
    scanStatus: "passed\u0007",
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
  }),
  "lib-ctrl": answer(`lib${OSC_TITLE}-ctrl\r\nSECOND LINE`, { packageType: "library" }),
  "one-bad-count": answer("one-bad-count", {
    securityProfile: { criticalCount: null, highCount: 2 },
  }),
  "two-bad-fields": answer("two-bad-fields", {
    securityProfile: { criticalCount: "3", highCount: -1, knownCves: "CVE" },
  }),
  "warnings-clean": answer("warnings-clean", {
    scanStatus: "warnings",
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
  }),
  "warnings-no-profile": answer("warnings-no-profile", { scanStatus: "warnings" }),
  "rich-mcp": answer("rich-mcp", { scanStatus: "completed" }),
  "pypi-lib": answer("pypi-lib", { packageType: "library", verdict: "listed" }),
  // A scan date under a scan status that is not a finished one.
  "pending-dated": answer("pending-dated", {
    trustLevel: 2,
    trustScore: 0.773,
    verdict: "listed",
    scanStatus: "pending",
    lastScannedAt: SCANNED_231_DAYS_AGO,
    securityProfile: { criticalCount: 0, highCount: 1, knownCves: [] },
  }),
  // Trust scores off the 0-1 scale, as in BATCH.
  "score-55": answer("score-55", { trustScore: 55, scanStatus: "completed" }),
  "score-negative": answer("score-negative", { trustScore: -0.5, scanStatus: "completed" }),
  "score-text": answer("score-text", { trustScore: "high", scanStatus: "completed" }),
  // A scan status that is not a string, and a trust level that is not a whole number (#238).
  "status-zero": listedAnswer("status-zero", {
    scanStatus: 0,
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
  }),
  "status-false": listedAnswer("status-false", {
    scanStatus: false,
    lastScannedAt: undefined,
    securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
  }),
  "status-number": listedAnswer("status-number", { scanStatus: 5 }),
  "status-object": listedAnswer("status-object", {
    scanStatus: { state: "passed" },
    lastScannedAt: undefined,
  }),
  "level-tab": listedAnswer("level-tab", { trustLevel: "\t1", scanStatus: "warnings" }),
  // Names with shell syntax in them, answered for a plain query name.
  "shell-lib": answer("shell-lib; echo injected", { packageType: "library", verdict: "listed" }),
  "shell-mcp": answer("shell-mcp; echo injected"),
  // Answered with the all-zero id: the client reads it as "not found".
  "pypi-missing": answer("pypi-missing", {
    packageId: "00000000-0000-0000-0000-000000000000",
    packageType: undefined,
    trustLevel: 0,
    trustScore: 0,
    verdict: "",
    scanStatus: "",
    communityScans: 0,
  }),
};

const BATCH: Record<string, Record<string, unknown>> = {
  "running-mcp": answer("running-mcp", {
    trustLevel: 2,
    trustScore: 0,
    verdict: "listed",
    scanStatus: "running",
    communityScans: 0,
  }),
  // Not in the registry: the all-zero id, under a name that is not the one asked for.
  "missing-ctrl": answer(`miss${OSC_TITLE}-ing\r\nSECOND LINE`, {
    packageId: "00000000-0000-0000-0000-000000000000",
    packageType: undefined,
    trustLevel: 0,
    trustScore: 0,
    verdict: "",
    scanStatus: "",
    communityScans: 0,
  }),
  "row-ctrl": answer(`row${OSC_TITLE}-ctrl\r\nSECOND LINE`, {
    packageType: "mcp_server\u0007",
    trustLevel: 1,
    verdict: "warning",
    scanStatus: "warnings\u001b[1m",
  }),
  // Trust scores off the 0-1 scale.
  "score-55": answer("score-55", { trustScore: 55, scanStatus: "completed" }),
  "score-negative": answer("score-negative", { trustScore: -0.5, scanStatus: "completed" }),
  "score-text": answer("score-text", { trustScore: "high", scanStatus: "completed" }),
  // A trust level that is not a whole number, and a scan status that is not a string (#238).
  "level-tab": listedAnswer("level-tab", { trustLevel: "\t1", scanStatus: "warnings" }),
  "level-fraction": listedAnswer("level-fraction", { trustLevel: 1.5, scanStatus: "warnings" }),
  "status-number": listedAnswer("status-number", { scanStatus: 5 }),
};

const NARRATIVE = {
  artifactType: "mcp",
  packageName: "rich-mcp",
  packageVersion: "1.0.0",
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00Z",
  summary: `summary${OSC_TITLE}\r\nSUMMARY SECOND LINE`,
  hardcodedSecrets: { detected: [], scanCovered: true },
  mcp: {
    mcpName: `rich${OSC_TITLE}-mcp`,
    tools: [
      {
        name: `read_file${OSC_TITLE}`,
        signature: "(path)\u001b[2J",
        description: "reads a file\r\nTOOL SECOND LINE",
        destructive: false,
      },
    ],
    pathScope: "workspace\u0007 only",
    network: "none\u009b31m",
    persistence: "none",
    auth: "none",
    sideEffects: [`writes${OSC_TITLE} nothing`],
  },
  verdictReasoning: [{ kind: "positive", text: `reasoning${OSC_TITLE}\r\nREASON SECOND LINE` }],
  nextSteps: [{ weight: "primary", label: `step${OSC_TITLE}`, command: "ai-trust check x\r\ny" }],
};

let server: Server;
let registryUrl: string;
let scratch: string;
let requests: string[];

function startRegistry(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const sendBadBody = () => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(BAD_BODY);
    };
    if (req.method === "GET" && url.pathname === "/api/v1/trust/query") {
      if (url.searchParams.get("name") === BAD_BODY_PACKAGE) return sendBadBody();
      const found = QUERY[url.searchParams.get("name") ?? ""];
      if (found === undefined) return send(404, { error: "package not found" });
      return send(200, found);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/trust/narrative") {
      if (url.searchParams.get("name") !== "rich-mcp") return send(404, { error: "none" });
      return send(200, NARRATIVE);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/trust/batch") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { packages } = JSON.parse(body) as { packages: Array<{ name: string }> };
        if (packages.some((p) => p.name === BAD_BODY_PACKAGE)) return sendBadBody();
        if (packages.some((p) => p.name === STATUS_500_PACKAGE)) {
          return send(500, { error: "internal error" });
        }
        const results = packages.map((p) => BATCH[p.name] ?? answer(p.name));
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
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun, reject) => {
    // Minimal environment: no host config, no consent file, no telemetry.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      NO_COLOR: "1",
      CI: "true",
      OPENA2A_TELEMETRY: "off",
      ...extraEnv,
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
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
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

/**
 * Writes a package.json listing `dependencies` in the directory `dir` under
 * the scratch directory, which is where the CLI runs, and returns its path
 * from there. audit reads only a file named package.json or a requirements
 * file, so each test that needs its own file gets its own directory.
 */
function writeManifest(dir: string, dependencies: Record<string, string>): string {
  const file = join(dir, "package.json");
  mkdirSync(join(scratch, dir), { recursive: true });
  writeFileSync(
    join(scratch, file),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }),
  );
  return file;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-answers-"));
  requests = [];
  server = await startRegistry();
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("registry answers through the built CLI", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  // A case here runs the built CLI up to three times; on Node 20 in CI three
  // runs took longer than the 5 s default.
  describe("control characters in registry strings", { timeout: 30000 }, () => {
    it("check --no-scan prints a listed CVE without them and adds no output line", async () => {
      const dirty = await runCli(["check", "cve-ctrl", "--no-scan"]);
      const clean = await runCli(["check", "cve-clean", "--no-scan"]);

      expect(dirty.stdout).not.toMatch(CONTROL);
      expect(dirty.stdout.split("\n")).toHaveLength(clean.stdout.split("\n").length);
      expect(dirty.stdout).toMatch(/^ {2}CVEs {6}CVE-\]0;x-1 EXTRA LINE$/m);
      expect(dirty.stdout).not.toMatch(/^EXTRA LINE$/m);
    });

    it("check --no-scan --json carries the CVE as the registry sent it", async () => {
      const { stdout, status } = await runCli(["check", "cve-ctrl", "--no-scan", "--json"]);

      expect(status).toBe(0);
      expect(stdout).not.toMatch(CONTROL);
      expect(JSON.parse(stdout).securityProfile.knownCves).toEqual([RAW_CVE]);
    });

    it("check --no-scan prints the name, package type and scan status without them", async () => {
      const { stdout, stderr } = await runCli(["check", "name-ctrl", "--no-scan"]);

      expect(stdout).not.toMatch(CONTROL);
      expect(stderr).not.toMatch(CONTROL);
      expect(stdout).toMatch(
        /^ {2}name\]0;x-ctrl SECOND LINE {2}mcp server\[2J · scan date not recorded$/m,
      );
      expect(stdout).toMatch(/scan status passed$/m);
      expect(stdout).not.toMatch(/^SECOND LINE/m);
    });

    it("check --no-scan prints a registry-classified library's name without them", async () => {
      const { stdout, stderr, status } = await runCli(["check", "lib-ctrl", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).not.toMatch(CONTROL);
      expect(stderr).not.toMatch(CONTROL);
      expect(stdout).toContain("lib]0;x-ctrl SECOND LINE  library (registry-classified)");
      // Quoted for the shell: the name has a ";" and spaces in it (#141).
      expect(stdout).toContain("npx hackmyagent check 'lib]0;x-ctrl SECOND LINE'");
    });

    it("check mcp:<name> prints the registry's narrative without them", async () => {
      const { stdout, status } = await runCli(["check", "mcp:rich-mcp"]);

      expect(status).toBe(0);
      expect(stdout).not.toMatch(CONTROL);
      expect(stdout).toContain("(path)[2J  — reads a file TOOL SECOND LINE");
      expect(stdout).toContain("Side effects:  writes]0;x nothing");
      expect(stdout).toContain("reasoning]0;x REASON SECOND LINE");
      expect(stdout).toContain("step]0;x:  ai-trust check x y");
      expect(stdout).not.toMatch(/^(TOOL|REASON) SECOND LINE/m);
    });

    it("check mcp:<name> --json carries the narrative as the registry sent it", async () => {
      const { stdout, status } = await runCli(["check", "mcp:rich-mcp", "--json"]);

      expect(status).toBe(0);
      expect(stdout).not.toMatch(CONTROL);
      const parsed = JSON.parse(stdout);
      expect(parsed.mcp.tools[0].name).toBe(`read_file${OSC_TITLE}`);
      // A C1 control, which JSON.stringify leaves raw, is written as an escape.
      expect(stdout).toContain('"network": "none\\u009b31m"');
      expect(parsed.mcp.network).toBe("none\u009b31m");
    });

    it("batch and audit print the name, type and scan status of a row without them", async () => {
      const manifest = writeManifest("rows", { "row-ctrl": "1.0.0" });
      for (const args of [
        ["batch", "row-ctrl", "--min-trust", "3"],
        ["audit", manifest, "--min-trust", "3"],
      ]) {
        const { stdout, stderr, status } = await runCli(args);

        expect(status, args.join(" ")).toBe(2);
        expect(stdout, args.join(" ")).not.toMatch(CONTROL);
        expect(stderr, args.join(" ")).not.toMatch(CONTROL);
        // Table row, then the below-threshold summary line.
        expect(stdout, args.join(" ")).toMatch(
          /^ {2}row\]0;x-ctrl SECOND LINE\s+mcp_server\s+WARNING\s.*warnings\[1m\s*$/m,
        );
        expect(stdout, args.join(" ")).toMatch(/^ {2}│ row\]0;x-ctrl SECOND LINE {2}/m);
      }
    });

    it("audit --scan-missing prints the name the registry returned for a missing package without them", async () => {
      const manifest = writeManifest("missing", { "missing-ctrl": "1.0.0" });
      // The answer's name is not one the dependency file lists, so audit
      // reports it and downloads nothing. npm is pointed at the fixture
      // server, which has no such package, in case a download is attempted.
      const { stdout, stderr } = await runCli(
        ["audit", manifest, "--scan-missing", "--no-contribute"],
        {
          npm_config_registry: registryUrl,
          npm_config_cache: join(scratch, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      );

      expect(stdout).not.toMatch(CONTROL);
      expect(stderr).not.toMatch(CONTROL);
      expect(stderr).toContain(
        "  Not scanning miss]0;x-ing SECOND LINE: the registry answered with a name the dependency file does not list.",
      );
      expect(stderr).not.toContain("  Scanning miss");
    }, 60000);

    it("check --no-scan, batch and audit print a registry error without them", async () => {
      const manifest = writeManifest("bad-body", { "bad-body": "1.0.0" });
      for (const args of [
        ["check", BAD_BODY_PACKAGE, "--no-scan"],
        ["batch", BAD_BODY_PACKAGE],
        ["audit", manifest],
      ]) {
        const { stdout, stderr, status } = await runCli(args);

        expect(status, args.join(" ")).toBe(1);
        expect(stdout, args.join(" ")).not.toMatch(CONTROL);
        expect(stderr, args.join(" ")).not.toMatch(CONTROL);
        expect(stderr, args.join(" ")).toMatch(/^Error: Registry returned invalid JSON: /);
        expect(stderr, args.join(" ")).toContain("]0;x<html>");
      }
    });

    it("check prints a failed registry lookup without them before it scans", async () => {
      // npm reads the fixture server, which has no such package, so the scan
      // that follows the failed lookup ends at the download.
      const { stdout, stderr, status } = await runCli(["check", BAD_BODY_PACKAGE], {
        npm_config_registry: registryUrl,
        npm_config_cache: join(scratch, "npm-cache"),
        npm_config_update_notifier: "false",
      });

      expect(status).toBe(2);
      expect(stdout).not.toMatch(CONTROL);
      expect(stderr).not.toMatch(CONTROL);
      expect(stderr).toMatch(/Registry lookup failed \(Registry returned invalid JSON: .*\]0;x<html>/);
    }, 60000);
  });

  describe("a registry that answers the batch query with an error (#237)", { timeout: 30000 }, () => {
    it("audit names the registry and a next step after an HTTP 500 or a body that is not JSON, as batch does", async () => {
      for (const { name, error, answered } of [
        {
          name: STATUS_500_PACKAGE,
          error: "Error: Registry API returned 500",
          answered: "answered 500",
        },
        {
          name: BAD_BODY_PACKAGE,
          error: expect.stringMatching(/^Error: Registry returned invalid JSON: /),
          answered: "answered 200 with a body that is not JSON",
        },
      ]) {
        const manifest = writeManifest(`answered-${name}`, { [name]: "1.0.0" });
        const audit = await runCli(["audit", manifest]);
        const batch = await runCli(["batch", name]);

        expect(audit.status, name).toBe(1);
        expect(audit.stderr.split("\n").slice(0, 3), name).toEqual([
          error,
          `  No dependencies were checked: the registry at ${registryUrl} ${answered}.`,
          "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check <package>",
        ]);
        expect(batch.status, name).toBe(1);
        expect(batch.stderr.split("\n").slice(0, 3), name).toEqual([
          error,
          `  The registry at ${registryUrl} ${answered}.`,
          `  Next: run the batch again when the registry answers, or check one package locally with ai-trust check ${name}`,
        ]);
      }
    });
  });

  describe("a security profile with a field the reader cannot use", () => {
    it("shows the high count when the critical count is null", async () => {
      const { stdout, status } = await runCli(["check", "one-bad-count", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).not.toContain("No known issues");
      expect(stdout).toContain("Passed, but the registry recorded 2 high findings");
      expect(stdout).toMatch(
        /^ {2}Findings {2}critical not reported · 2 high \(details not returned\) · scan status passed$/m,
      );
      expect(stdout).toMatch(/^ {2}CVEs {6}none recorded$/m);
    });

    it("--json keeps the high count and omits the critical count", async () => {
      const { stdout } = await runCli(["check", "one-bad-count", "--no-scan", "--json"]);

      expect(JSON.parse(stdout).securityProfile).toEqual({ highCount: 2, knownCves: [] });
    });

    it("reads a digit-string count and a bare CVE string beside a negative count", async () => {
      const { stdout } = await runCli(["check", "two-bad-fields", "--no-scan"]);

      expect(stdout).not.toContain("No known issues");
      expect(stdout).toContain(
        "Passed, but the registry recorded 3 critical findings, plus 1 known CVE",
      );
      expect(stdout).toMatch(
        /^ {2}Findings {2}3 critical \(details not returned\) · high not reported · scan status passed$/m,
      );
      expect(stdout).toMatch(/^ {2}CVEs {6}CVE$/m);

      const json = await runCli(["check", "two-bad-fields", "--no-scan", "--json"]);
      expect(JSON.parse(json.stdout).securityProfile).toEqual({
        criticalCount: 3,
        knownCves: ["CVE"],
      });
    });
  });

  describe("a passed verdict over a `warnings` scan status", () => {
    it("does not say 'No known issues' when the profile is clean", async () => {
      const { stdout, status } = await runCli(["check", "warnings-clean", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).not.toContain("No known issues");
      expect(stdout).toMatch(/^ {2}Passed, but the registry's scan reported warnings$/m);
      expect(stdout).toMatch(/^ {2}Findings {2}0 critical · 0 high · scan status warnings$/m);
    });

    it("does not say 'No known issues' when no profile came back", async () => {
      const { stdout, status } = await runCli(["check", "warnings-no-profile", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).not.toContain("No known issues");
      expect(stdout).toMatch(/^ {2}Passed, but the registry's scan reported warnings$/m);
    });

    it("still says 'No known issues' for a passed scan status and a clean profile", async () => {
      const { stdout } = await runCli(["check", "cve-clean", "--no-scan"]);

      expect(stdout).toContain("Passed, but the registry recorded 1 known CVE");
      const plain = await runCli(["check", "rich-mcp", "--no-scan"]);
      expect(plain.stdout).toMatch(/^ {2}No known issues$/m);
    });
  });

  describe("a found package whose scan is in progress", () => {
    it("batch shows no score in the table or the summary", async () => {
      const { stdout, status } = await runCli(["batch", "running-mcp", "--min-trust", "3"]);

      expect(status).toBe(2);
      // "--" with no meter, which reads as a full one without color (#230).
      expect(stdout).toMatch(/^ {2}running-mcp\s+mcp_server\s+LISTED\s+Listed\s+-- +running\s*$/m);
      expect(stdout).toMatch(/^ {2}│ running-mcp {2}not scanned {2}Listed \(2\/4\)$/m);
      expect(stdout).not.toContain("0/100");
    });

    it("check --no-scan names the scan status and the last recorded scan instead of 'not scanned'", async () => {
      const { stdout, status } = await runCli(["check", "pending-dated", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).toMatch(/^ {2}pending-dated {2}mcp server · scanned 231 days ago \(stale\)$/m);
      expect(stdout).toMatch(
        /^ {2}Trust {5}score not shown: the registry's scan status is pending · last recorded scan 231 days ago \(stale\)$/m,
      );
      expect(stdout).toMatch(
        /^ {2}Findings {2}0 critical · 1 high \(details not returned\) · scan status pending$/m,
      );
      expect(stdout).not.toContain("not scanned");
      expect(stdout).not.toContain("request a scan");
      expect(stdout).not.toContain("77/100");
      expect(stdout).toContain("Scan locally  ai-trust check pending-dated");
    });

    it("check --no-scan --json carries the registry's scan status, date and score", async () => {
      const { stdout, status } = await runCli(["check", "pending-dated", "--no-scan", "--json"]);

      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.scanStatus).toBe("pending");
      expect(parsed.lastScannedAt).toBe(SCANNED_231_DAYS_AGO);
      expect(parsed.trustScore).toBe(0.773);
    });
  });

  // The #141 case here runs the built CLI three times and the table case
  // twice; on Node 20 in CI three runs took longer than the 5 s default.
  describe("a trust score off the 0-1 scale", { timeout: 30000 }, () => {
    const OFF_SCALE = ["score-55", "score-negative", "score-text"];

    it("batch and audit print the table with no score for it", async () => {
      const manifest = writeManifest(
        "off-scale",
        Object.fromEntries(OFF_SCALE.map((name) => [name, "1.0.0"])),
      );
      for (const args of [["batch", ...OFF_SCALE], ["audit", manifest]]) {
        const { stdout, stderr, status } = await runCli(args);

        expect(stderr, args.join(" ")).not.toContain("Invalid count value");
        expect(status, args.join(" ")).toBe(0);
        for (const name of OFF_SCALE) {
          expect(stdout, `${args.join(" ")}: ${name}`).toMatch(
            new RegExp(`^ {2}${name}\\s+mcp_server\\s+SAFE\\s+Scanned\\s+-- +completed\\s*$`, "m"),
          );
        }
        expect(stdout, args.join(" ")).not.toMatch(/5500|-50|NaN/);
      }
    });

    it("the below-threshold summary says the score is unavailable", async () => {
      const { stdout, status } = await runCli(["batch", "score-55", "--min-trust", "4"]);

      expect(status).toBe(2);
      expect(stdout).toMatch(/^ {2}│ score-55 {2}score unavailable {2}Scanned \(3\/4\)$/m);
    });

    it("batch --json carries the score as the registry sent it", async () => {
      const { stdout, status } = await runCli(["batch", "score-55", "--json"]);

      expect(status).toBe(0);
      expect(JSON.parse(stdout).results[0].trustScore).toBe(55);
    });

    it("check --no-scan prints -- for it, as batch and audit do (#141)", async () => {
      for (const name of OFF_SCALE) {
        const { stdout, stderr, status } = await runCli(["check", name, "--no-scan"]);

        expect(stderr, name).not.toContain("Invalid count value");
        expect(status, name).toBe(0);
        expect(stdout, name).toMatch(
          /^ {2}Trust +-- \(the registry's score is not a number from 0 to 1\)$/m,
        );
        expect(stdout, name).not.toMatch(/\/100|NaN/);
      }
    });
  });

  // A case here runs the built CLI up to four times; on Node 20 in CI three
  // runs took longer than the 5 s default.
  describe("a field of a type the answer does not declare (#238)", { timeout: 30000 }, () => {
    it("check --no-scan shows no score for a scan status that is not a string", async () => {
      for (const name of ["status-zero", "status-number"]) {
        const { stdout, stderr, status } = await runCli(["check", name, "--no-scan"]);

        expect(stderr, name).not.toContain("Error");
        expect(status, name).toBe(0);
        expect(stdout, name).toMatch(
          /^ {2}Trust {5}score not shown: the registry's scan status is not a string · last recorded scan 231 days ago \(stale\)$/m,
        );
        expect(stdout, name).not.toContain("/100");
      }
      for (const name of ["status-false", "status-object"]) {
        const { stdout, stderr, status } = await runCli(["check", name, "--no-scan"]);

        expect(stderr, name).not.toContain("Error");
        expect(status, name).toBe(0);
        expect(stdout, name).toMatch(/^ {2}Trust {5}not scanned/m);
      }
    });

    it("check --no-scan names no scan status beside the profile's counts", async () => {
      for (const name of ["status-zero", "status-false"]) {
        const { stdout } = await runCli(["check", name, "--no-scan"]);

        expect(stdout, name).toMatch(/^ {2}Findings {2}0 critical · 0 high$/m);
      }
    });

    it("check --no-scan exits as --json does, and --json carries the scan status as sent", async () => {
      const text = await runCli(["check", "status-number", "--no-scan"]);
      const json = await runCli(["check", "status-number", "--no-scan", "--json"]);

      expect(json.status).toBe(0);
      expect(text.status).toBe(json.status);
      expect(JSON.parse(json.stdout).scanStatus).toBe(5);
    });

    it("check --no-scan prints - for a trust level that is not a whole number", async () => {
      const { stdout, stderr, status } = await runCli(["check", "level-tab", "--no-scan"]);

      expect(stderr).not.toContain("Error");
      expect(status).toBe(0);
      expect(stdout).toMatch(
        /^ {2}Level {5}- \(the registry's trust level is not a whole number\)$/m,
      );
      expect(stdout).not.toContain("undefined");
    });

    it("batch and audit print - for the level, and exit 2 as they do with --json", async () => {
      const manifest = writeManifest("level-tab", { "level-tab": "1.0.0" });
      for (const args of [["batch", "level-tab"], ["audit", manifest]]) {
        const { stdout, stderr, status } = await runCli(args);
        const json = await runCli([...args, "--json"]);

        expect(stderr, args.join(" ")).not.toContain("Error");
        expect(json.status, args.join(" ")).toBe(2);
        expect(status, args.join(" ")).toBe(json.status);
        expect(JSON.parse(json.stdout).results[0].trustLevel, args.join(" ")).toBe("\t1");
        // Table row, then the below-threshold summary line.
        expect(stdout, args.join(" ")).toMatch(
          /^ {2}level-tab\s+mcp_server\s+LISTED\s+- {11}\S.*\swarnings\s*$/m,
        );
        expect(stdout, args.join(" ")).toMatch(/^ {2}│ level-tab {2}\S.* {2}level unavailable$/m);
        expect(stdout, args.join(" ")).not.toContain("undefined");
      }
    });

    it("batch and audit print - for a fractional trust level and for a scan status that is a number", async () => {
      const manifest = writeManifest("fraction-number", {
        "level-fraction": "1.0.0",
        "status-number": "1.0.0",
      });
      for (const args of [["batch", "level-fraction", "status-number"], ["audit", manifest]]) {
        const { stdout, stderr, status } = await runCli(args);

        expect(stderr, args.join(" ")).not.toContain("Error");
        // 1.5 is below the default minimum trust level 2.
        expect(status, args.join(" ")).toBe(2);
        expect(stdout, args.join(" ")).toMatch(
          /^ {2}level-fraction\s+mcp_server\s+LISTED\s+- {11}\S.*\swarnings\s*$/m,
        );
        // SCORE is "--", after an empty meter or with none.
        expect(stdout, args.join(" ")).toMatch(
          /^ {2}status-number\s+mcp_server\s+LISTED\s+Listed\s+(?:━{8} )?-- +-\s*$/m,
        );
      }
    });
  });

  describe("a registry answer with the all-zero package id (#141)", () => {
    it("check --no-scan prints the same not-found block and exit code 2 as a 404", async () => {
      const zero = await runCli(["check", "pypi-missing", "--no-scan"]);
      const miss = await runCli(["check", "not-in-fixture", "--no-scan"]);

      expect(miss.status).toBe(2);
      expect(zero.status).toBe(2);
      expect(zero.stdout).toBe(miss.stdout.replaceAll("not-in-fixture", "pypi-missing"));
    });

    it("check --no-scan --json prints the not-found output and exits 2", async () => {
      const { stdout, status } = await runCli(["check", "pypi-missing", "--no-scan", "--json"]);

      expect(status).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({
        name: "pypi-missing",
        found: false,
        error: 'Package "pypi-missing" not found in the OpenA2A Registry.',
      });
    });
  });

  describe("a registry name with shell syntax in a suggested command (#141)", () => {
    it("check pip:<name> --no-scan quotes it in the hackmyagent check command", async () => {
      const { stdout } = await runCli(["check", "pip:shell-lib", "--no-scan"]);

      expect(stdout.split("\n")).toContain("    npx hackmyagent check 'pip:shell-lib; echo injected'");
    });

    it("check pip:<name> --no-scan --json quotes it in nextSteps", async () => {
      const { stdout } = await runCli(["check", "pip:shell-lib", "--no-scan", "--json"]);

      expect(JSON.parse(stdout).nextSteps).toEqual([
        "npx hackmyagent check 'pip:shell-lib; echo injected'",
      ]);
    });

    it("check --no-scan quotes it in the Next Steps check command", async () => {
      const { stdout } = await runCli(["check", "shell-mcp", "--no-scan"]);

      expect(stdout).toContain("ai-trust check 'shell-mcp; echo injected'");
      expect(stdout).not.toMatch(/check shell-mcp; echo/);
    });
  });

  describe("an ecosystem prefix with no package name", () => {
    it("check pip: is a usage error and asks the registry nothing", async () => {
      const before = requests.length;
      const { stdout, stderr, status } = await runCli(["check", "pip:", "--no-scan"]);

      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        'Error: No package name after "pip:". Usage: ai-trust check pip:<package>\n',
      );
      expect(requests.slice(before)).toEqual([]);
    });

    it("check npm: is a usage error with --json and without --no-scan", async () => {
      const before = requests.length;
      const { stdout, stderr, status } = await runCli(["check", "npm:", "--json"]);

      expect(status).toBe(1);
      expect(JSON.parse(stdout)).toEqual({
        error: 'No package name after "npm:". Usage: ai-trust check npm:<package>',
      });
      expect(stderr).toBe("");
      expect(requests.slice(before)).toEqual([]);
    });

    it("check pip:<name> is still looked up, as a pypi package", async () => {
      const before = requests.length;
      const { stdout, status } = await runCli(["check", "pip:not-in-fixture", "--no-scan"]);

      expect(status).toBe(2);
      expect(stdout).toContain("Package not found: not-in-fixture (pypi)");
      expect(requests.slice(before)).toContain("GET /api/v1/trust/query");
    });
  });

  describe("the ecosystem a target was checked under (#131)", () => {
    it("check pip:<name> --no-scan --json says pypi for a registry-classified library", async () => {
      const { stdout, status } = await runCli(["check", "pip:pypi-lib", "--no-scan", "--json"]);

      expect(status).toBe(0);
      const json = JSON.parse(stdout);
      expect(json).toMatchObject({ name: "pypi-lib", ecosystem: "pypi", outOfScope: true });
      expect(Object.keys(json).slice(0, 2)).toEqual(["name", "ecosystem"]);
    });

    it("check pip:<name> --no-scan names pypi beside a registry-classified library", async () => {
      const { stdout } = await runCli(["check", "pip:pypi-lib", "--no-scan"]);

      expect(stdout).toContain("pypi-lib (pypi)  library (registry-classified)");
    });

    it("check pip:<name> --no-scan --json says pypi for a registry answer", async () => {
      const { stdout } = await runCli(["check", "pip:cve-clean", "--no-scan", "--json"]);

      const json = JSON.parse(stdout);
      expect(json).toMatchObject({ name: "cve-clean", ecosystem: "pypi", source: "registry" });
      expect(Object.keys(json).slice(0, 2)).toEqual(["name", "ecosystem"]);
    });

    it("check pip:<name> --no-scan names pypi in the header of a registry answer", async () => {
      const { stdout } = await runCli(["check", "pip:cve-clean", "--no-scan"]);

      const header = stdout.split("\n").find((l) => l.trim().length > 0);
      expect(header).toMatch(/^ {2}cve-clean \(pypi\) {2}/);
    });

    it("check pip:<name> --no-scan says pypi when the registry answers with no package", async () => {
      const { stdout } = await runCli(["check", "pip:pypi-missing", "--no-scan"]);

      expect(stdout).toContain("Package not found: pypi-missing (pypi)");
    });

    it("check pip:<name> --no-scan --json says pypi for a library known by name only", async () => {
      const { stdout, status } = await runCli(["check", "pip:chalk", "--no-scan", "--json"]);

      expect(status).toBe(0);
      const json = JSON.parse(stdout);
      expect(json).toMatchObject({ name: "chalk", ecosystem: "pypi", found: false, outOfScope: true });
      expect(Object.keys(json).slice(0, 2)).toEqual(["name", "ecosystem"]);
    });

    it("check pip:<name> --no-scan names pypi beside a library known by name only", async () => {
      const { stdout } = await runCli(["check", "pip:chalk", "--no-scan"]);

      expect(stdout).toContain("chalk (pypi)  library (by name");
    });

    it("check <name> --no-scan --json says npm, and the text header names no ecosystem", async () => {
      const json = JSON.parse((await runCli(["check", "cve-clean", "--no-scan", "--json"])).stdout);
      const { stdout } = await runCli(["check", "cve-clean", "--no-scan"]);

      expect(json).toMatchObject({ name: "cve-clean", ecosystem: "npm" });
      const header = stdout.split("\n").find((l) => l.trim().length > 0);
      expect(header).toMatch(/^ {2}cve-clean {2}/);
    });
  });

  describe("the out-of-scope notice is the command's output (#218)", () => {
    it("check --no-scan prints a registry-classified library's notice on stdout", async () => {
      const { stdout, stderr, status } = await runCli(["check", "pip:pypi-lib", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).toContain("Out of scope for ai-trust");
      expect(stdout).toContain("npx hackmyagent check pip:pypi-lib");
      expect(stderr).not.toContain("Out of scope for ai-trust");
    });

    it("check --no-scan prints a by-name library's notice on stdout", async () => {
      const { stdout, stderr, status } = await runCli(["check", "express", "--no-scan"]);

      expect(status).toBe(0);
      expect(stdout).toContain("express  library (by name — no registry data)");
      expect(stdout).toContain("npx hackmyagent check express");
      expect(stderr).not.toContain("Out of scope for ai-trust");
    });
  });
});
