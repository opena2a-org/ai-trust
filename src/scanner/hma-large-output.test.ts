/**
 * A scan report larger than Node's default `execFile` buffer.
 *
 * The scanner writes its JSON report to stdout, and the report grows with the
 * findings it lists. Node's `execFile` buffers at most 1 MiB of a child's
 * stdout by default, and a larger report failed the scan with "stdout
 * maxBuffer length exceeded". These tests compile the real scanner modules
 * into a fake install tree whose `hackmyagent` writes a report over 1 MiB,
 * and assert that `scanLocalPath` (what `check --scan-path` runs) returns a
 * verdict read from the whole report.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The modules `scanLocalPath` loads, relative to src/: the scanner modules and
 * the ai-trust modules `hma.ts` imports, with the modules they import,
 * compiled into the fake install.
 */
const SCANNER_SOURCES = [
  "scanner/index.ts",
  "scanner/hma.ts",
  "scanner/downloader.ts",
  "scanner/mask-secrets.ts",
  "telemetry/opt-in.ts",
  "utils/cli-prefix.ts",
];

/** Node's default `maxBuffer` for `execFile`, in bytes. */
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Passing check records that take the report past NODE_DEFAULT_MAX_BUFFER. */
const PASSING_CHECKS = 6000;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hma-large-output-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A report with one failing high finding and PASSING_CHECKS passing records
 * in `allFindings`, scored 85: a verdict of "warning" read from it shows the
 * failing finding was parsed, and `checksEvaluated` shows every record was.
 */
function oversizedReport(): string {
  const failing = {
    checkId: "TEST-HIGH-001",
    name: "Failing test check",
    description: "A failing check in a report larger than 1 MiB",
    category: "test",
    severity: "high",
    passed: false,
    message: "The failing check of the oversized report",
    file: "index.js",
    line: 1,
  };
  const passing = Array.from({ length: PASSING_CHECKS }, (_, i) => ({
    checkId: `TEST-PASS-${i}`,
    name: `Passing test check ${i}`,
    description: "A passing check that pads the report past 1 MiB of standard output",
    category: "test",
    severity: "low",
    passed: true,
    message: "Nothing to report for this check in the scanned directory",
  }));
  return JSON.stringify({
    score: 85,
    maxScore: 100,
    projectType: "mcp",
    timestamp: "2026-01-01T00:00:00Z",
    findings: [failing],
    allFindings: [failing, ...passing],
  });
}

/** Install a fake `hackmyagent` whose `secure` writes `report` and exits with `exitCode`. */
function installScanner(nodeModules: string, report: string, exitCode: number): void {
  const pkgDir = join(nodeModules, "hackmyagent");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "hackmyagent",
      version: "0.0.0-test",
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      bin: { hackmyagent: "dist/cli.js" },
    }),
  );
  writeFileSync(join(pkgDir, "dist", "index.js"), "module.exports = {};\n");
  writeFileSync(join(pkgDir, "dist", "report.json"), report);
  writeFileSync(
    join(pkgDir, "dist", "cli.js"),
    [
      "#!/usr/bin/env node",
      'const { readFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'if (process.argv.includes("--version")) { console.log("0.0.0-test"); process.exit(0); }',
      'process.stdout.write(readFileSync(join(__dirname, "report.json"), "utf8"));',
      `process.exitCode = ${exitCode};`,
      "",
    ].join("\n"),
  );
}

/** Compile SCANNER_SOURCES into `<consumer>/node_modules/ai-trust/dist/`. */
function installAiTrust(consumer: string): string {
  const pkgDir = join(consumer, "node_modules", "ai-trust");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "ai-trust", version: "0.0.0-test", type: "module" }),
  );
  for (const source of SCANNER_SOURCES) {
    const { outputText } = ts.transpileModule(readFileSync(join(SRC_DIR, source), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const outPath = join(pkgDir, "dist", source.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, outputText);
  }
  return join(pkgDir, "dist", "scanner", "index.js");
}

interface ScanOutcome {
  verdict?: string;
  score?: number;
  findings?: number;
  checksEvaluated?: number;
  error?: string;
}

async function scanLocalPathWith(modulePath: string): Promise<ScanOutcome> {
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  // runHmaScan reads, and can mark, the saved contribution choice under HOME,
  // so the child runs with an empty HOME of its own.
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const script = [
    `const scanner = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    "const out = {};",
    "try {",
    `  const r = await scanner.scanLocalPath(${JSON.stringify(target)}, { deep: false });`,
    "  out.verdict = r.verdict;",
    "  out.score = r.scan.score;",
    "  out.findings = r.scan.findings.length;",
    "  out.checksEvaluated = r.scan.checksEvaluated;",
    "} catch (err) { out.error = String(err && err.message ? err.message : err); }",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, OPENA2A_HOME: join(home, ".opena2a") },
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout.trim().split("\n").pop() as string) as ScanOutcome;
}

describe("a scanner report larger than Node's default execFile buffer", () => {
  const report = oversizedReport();

  it("is larger than 1 MiB", () => {
    expect(Buffer.byteLength(report)).toBeGreaterThan(NODE_DEFAULT_MAX_BUFFER);
  });

  it.each([
    ["exits 0", 0],
    ["exits 1 with the report on stdout", 1],
  ])(
    "gives a verdict read from the whole report when the scanner %s",
    async (_label, exitCode) => {
      const consumer = join(root, `exit-${exitCode}`);
      installScanner(join(consumer, "node_modules"), report, exitCode);
      const modulePath = installAiTrust(consumer);

      const outcome = await scanLocalPathWith(modulePath);

      expect(outcome.error).toBeUndefined();
      expect(outcome.verdict).toBe("warning");
      expect(outcome.score).toBe(85);
      expect(outcome.findings).toBe(1);
      expect(outcome.checksEvaluated).toBe(PASSING_CHECKS + 1);
    },
    60_000,
  );
});
