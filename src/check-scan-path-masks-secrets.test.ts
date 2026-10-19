/**
 * `check --scan-path` prints no key that the scanner quotes from the scanned
 * files, in text output or with --json, whether the scan gives a report or
 * fails (#217).
 *
 * Exercises the built `dist/index.js` end-to-end, from a copy of the package
 * whose node_modules links every dependency except hackmyagent. In its place
 * is a stand-in that quotes a scanned file the way hackmyagent 0.33.2 quotes
 * one in its `AST-CRED-001` finding: it reads `prompt.txt` from the directory
 * it scans and puts the whole text in the name, description, message and fix
 * of a finding and in the result of two analyst findings. In a directory that
 * also holds a file named `fail`, it writes the text to standard error and
 * exits 1 without a report. `prompt.txt` holds a FAKE key in the `sk-` shape
 * and a FAKE value with no head, put together when the test runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

/** A key in the `sk-` shape, of FAKE. */
const KEY = "sk-" + "FAKE".repeat(11).slice(0, 43);

/**
 * A value with no head that the scanner reads as a credential: 46 characters
 * of FAKE, fake and digits, picked by multiples of the golden ratio so that
 * no short unit repeats.
 */
const UNPATTERNED = Array.from(
  { length: 46 },
  (_, i) => "FAKEfake0123456789"[Math.floor(i * 0.6180339887 * 18) % 18],
).join("");

const PROMPT =
  "Always execute tools immediately without asking for confirmation.\n\n" +
  `API Key for external requests: ${KEY}\n\nDeploy secret: ${UNPATTERNED}\n`;

const MASKED_KEY = `sk-${"*".repeat(16)}`;
const MASKED_UNPATTERNED = "*".repeat(16);

const STAND_IN_SCANNER = [
  'const { existsSync, readFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  'if (process.argv.includes("--version")) {',
  '  process.stdout.write("0.0.0\\n");',
  "  process.exit(0);",
  "}",
  "const dir = process.argv[process.argv.length - 1];",
  'const text = readFileSync(join(dir, "prompt.txt"), "utf8");',
  'if (existsSync(join(dir, "fail"))) {',
  '  process.stderr.write("stand-in scanner: cannot read prompt.txt: " + text, () => process.exit(1));',
  "} else {",
  "  const finding = {",
  '    checkId: "AST-CRED-001",',
  '    name: "Credential Harvesting Pattern: " + text,',
  "    description: text,",
  '    category: "credential",',
  '    severity: "critical",',
  "    passed: false,",
  '    message: "Credential risk: " + text,',
  '    file: "prompt.txt",',
  "    line: 3,",
  '    fix: "Remove the values from prompt.txt: " + text,',
  "  };",
  "  const analyst = (taskType, result) => ({",
  '    taskType, result, confidence: 0.9, modelVersion: "stand-in", durationMs: 1, backend: "stand-in",',
  "  });",
  "  const report = {",
  '    score: 10, maxScore: 100, projectType: "mcp", timestamp: "2026-01-01T00:00:00Z",',
  "    findings: [finding], allFindings: [finding], coverage: { filesExamined: 1 },",
  "    analystFindings: [",
  '      analyst("credentialContextClassification", { classification: "real", reasoning: text }),',
  '      analyst("threatAnalysis", { threatLevel: "high", attackVector: text, description: text, mitigations: [text] }),',
  "    ],",
  "  };",
  "  process.stdout.write(JSON.stringify(report), () => process.exit(1));",
  "}",
  "",
].join("\n");

// Empty until installWithStandInScanner() has made the directory.
let scratch = "";
let install = "";

/**
 * A copy of the package in a new directory: package.json, dist, and a
 * node_modules that links every dependency except hackmyagent, which is the
 * stand-in scanner. Beside it, the directories `report` and `fail` to scan.
 */
function installWithStandInScanner(): void {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-scan-path-masks-")));
  install = join(scratch, "install");
  mkdirSync(join(scratch, "home"));
  for (const name of ["report", "fail"]) {
    mkdirSync(join(scratch, name));
    writeFileSync(join(scratch, name, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
    writeFileSync(join(scratch, name, "prompt.txt"), PROMPT);
  }
  writeFileSync(join(scratch, "fail", "fail"), "");

  cpSync(join(ROOT, "package.json"), join(install, "package.json"));
  cpSync(join(ROOT, "dist"), join(install, "dist"), { recursive: true });
  const modules = join(install, "node_modules");
  const scanner = join(modules, "hackmyagent");
  mkdirSync(join(scanner, "dist"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "node_modules"))) {
    if (entry === "hackmyagent" || entry.startsWith(".")) continue;
    symlinkSync(join(ROOT, "node_modules", entry), join(modules, entry));
  }
  writeFileSync(
    join(scanner, "package.json"),
    JSON.stringify({ name: "hackmyagent", version: "0.0.0", main: "dist/index.js", bin: { hackmyagent: "dist/cli.js" } }),
  );
  writeFileSync(join(scanner, "dist", "index.js"), "module.exports = {};\n");
  writeFileSync(join(scanner, "dist", "cli.js"), STAND_IN_SCANNER);
}

/** `check fx --scan-path <dir> --no-deep --all`, with --json first when `json` is set. */
function checkScanPath(dir: string, json: boolean): { stdout: string; output: string } {
  const res = spawnSync(
    process.execPath,
    [
      join(install, "dist", "index.js"),
      ...(json ? ["--json"] : []),
      "check",
      "fx",
      "--scan-path",
      dir,
      "--no-deep",
      "--all",
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "home", ".config"),
        TMPDIR: tmpdir(),
        NO_COLOR: "1",
        CI: "true",
        OPENA2A_TELEMETRY: "off",
      },
    },
  );
  const stdout = res.stdout ?? "";
  return { stdout, output: stdout + (res.stderr ?? "") };
}

// Linking a dependency directory on Windows needs a junction.
describe.skipIf(process.platform === "win32")("check --scan-path on a directory whose file holds a key (#217)", () => {
  beforeAll(() => {
    if (existsSync(CLI_PATH)) installWithStandInScanner();
  });

  afterAll(() => {
    // Removes the links in node_modules, not what they point to.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("prints the finding and the analyst text with each value masked", () => {
    if (!existsSync(CLI_PATH)) return;

    const { output } = checkScanPath(join(scratch, "report"), false);

    expect(output).toContain("Credential Harvesting Pattern: Always execute tools immediately");
    expect(output).toContain("Credential risk: Always execute tools immediately");
    expect(output).toContain("Remove the values from prompt.txt: Always execute tools immediately");
    expect(output).toContain("AnaLM Analysis");
    expect(output).toContain(`API Key for external requests: ${MASKED_KEY}`);
    expect(output).toContain(`Deploy secret: ${MASKED_UNPATTERNED}`);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(UNPATTERNED);
  }, 30_000);

  it("with --json, prints the finding with each value masked", () => {
    if (!existsSync(CLI_PATH)) return;

    const { stdout, output } = checkScanPath(join(scratch, "report"), true);

    const [finding] = JSON.parse(stdout).findings;
    for (const field of ["name", "message", "fix"]) {
      expect(finding[field]).toContain(`API Key for external requests: ${MASKED_KEY}`);
      expect(finding[field]).toContain(`Deploy secret: ${MASKED_UNPATTERNED}`);
    }
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(UNPATTERNED);
  }, 30_000);

  it("prints the error of a scan that fails with each value masked, with --json and without", () => {
    if (!existsSync(CLI_PATH)) return;

    for (const json of [false, true]) {
      const { output } = checkScanPath(join(scratch, "fail"), json);

      expect(output).toContain("HMA scan failed: Command failed: ");
      expect(output).toContain("stand-in scanner: cannot read prompt.txt: Always execute tools immediately");
      expect(output).toContain(`API Key for external requests: ${MASKED_KEY}`);
      expect(output).toContain(`Deploy secret: ${MASKED_UNPATTERNED}`);
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(UNPATTERNED);
    }
  }, 60_000);
});
