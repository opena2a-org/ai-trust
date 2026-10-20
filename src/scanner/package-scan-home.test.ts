/**
 * A downloaded package's scan reports the package, not the skills the user
 * running ai-trust keeps under ~/.openclaw.
 *
 * hackmyagent 0.23.11, the scanner ai-trust 0.7.6 pins, added findings from
 * the scanning user's ~/.openclaw to the report of the directory it scanned.
 * With 77 SKILL.md files under ~/.openclaw/skills, its report for
 * @modelcontextprotocol/server-filesystem 1.0.0 held 1,541 findings from
 * ~/.openclaw and came to 1,209,720 bytes, past Node's default 1 MiB
 * `execFile` buffer, and ai-trust 0.7.6's
 * `check @modelcontextprotocol/server-filesystem` failed with
 * "stdout maxBuffer length exceeded".
 *
 * This test compiles the scanner modules into a fake install tree beside a
 * link to the pinned scanner, runs `scanPackage` (what the default
 * `check <package>` runs) with `deep: false` on a fixture package, once with
 * an empty HOME and once with a HOME holding OpenClaw skills, and asserts both
 * runs give the same verdict, score and findings, none of them under
 * ~/.openclaw. The `npm` on the child's PATH is a stand-in that answers
 * `npm pack` with the fixture's tarball instead of downloading one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The modules `scanPackage` loads, relative to src/: the scanner modules and
 * the ai-trust modules `hma.ts` imports, compiled into the fake install.
 */
const SCANNER_SOURCES = [
  "scanner/index.ts",
  "scanner/hma.ts",
  "scanner/downloader.ts",
  "scanner/mask-secrets.ts",
  "telemetry/opt-in.ts",
];

const FIXTURE_NAME = "fixture-mcp-server";
const FIXTURE_TARBALL = `${FIXTURE_NAME}-1.0.0.tgz`;

/** Skills written under ~/.openclaw/skills in the second HOME. */
const OPENCLAW_SKILLS = 3;

let root: string;
let modulePath: string;
let npmBin: string;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "package-scan-home-")));
  modulePath = installAiTrust(join(root, "consumer"));
  await packFixture();
  npmBin = installNpmStandIn();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Root of the `hackmyagent` package Node resolves for ai-trust: the pinned scanner. */
function pinnedScannerDir(): string {
  let dir = dirname(createRequire(import.meta.url).resolve("hackmyagent"));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "hackmyagent") {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("No hackmyagent package.json above the resolved entry point");
    }
    dir = parent;
  }
}

/**
 * Compile SCANNER_SOURCES into `<consumer>/node_modules/ai-trust/dist/` and
 * link `<consumer>/node_modules/hackmyagent` to the pinned scanner.
 */
function installAiTrust(consumer: string): string {
  const nodeModules = join(consumer, "node_modules");
  const pkgDir = join(nodeModules, "ai-trust");
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
  symlinkSync(pinnedScannerDir(), join(nodeModules, "hackmyagent"), "dir");
  return join(pkgDir, "dist", "scanner", "index.js");
}

/** A small package, packed the way npm packs it (files under `package/`). */
async function packFixture(): Promise<void> {
  const pkgDir = join(root, "fixture", "package");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: FIXTURE_NAME, version: "1.0.0", main: "index.js" }, null, 2),
  );
  writeFileSync(join(pkgDir, "index.js"), `console.log(${JSON.stringify(FIXTURE_NAME)});\n`);
  await execFileAsync("tar", [
    "czf",
    join(root, FIXTURE_TARBALL),
    "-C",
    join(root, "fixture"),
    "package",
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * An `npm` that answers `npm pack --ignore-scripts --no-color --pack-destination <dir> -- <name>`,
 * the call the downloader makes, by copying the fixture tarball into <dir>
 * and printing its file name, as npm does.
 */
function installNpmStandIn(): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      '[ "$1" = pack ] && [ "$4" = --pack-destination ] || exit 1',
      `cp ${shellQuote(join(root, FIXTURE_TARBALL))} "$5/" || exit 1`,
      `echo ${FIXTURE_TARBALL}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

function emptyHome(name: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** A HOME whose ~/.openclaw/skills holds OPENCLAW_SKILLS skills. */
function homeWithOpenClawSkills(name: string): string {
  const home = emptyHome(name);
  for (let i = 1; i <= OPENCLAW_SKILLS; i++) {
    const dir = join(home, ".openclaw", "skills", `fixture-skill-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        `name: fixture-skill-${i}`,
        "description: A skill kept in the scanning user's home directory, outside the scanned package.",
        "---",
        "",
        `# Fixture skill ${i}`,
        "",
        "Summarize the files the user names.",
        "",
      ].join("\n"),
    );
  }
  return home;
}

interface ScanOutcome {
  verdict?: string;
  score?: number;
  checksEvaluated?: number;
  /** `<checkId> <file>` for each finding, sorted. */
  findings?: string[];
  error?: string;
}

async function scanPackageWithHome(home: string): Promise<ScanOutcome> {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  const script = [
    `const scanner = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    "const out = {};",
    "try {",
    `  const r = await scanner.scanPackage(${JSON.stringify(FIXTURE_NAME)}, { deep: false });`,
    "  out.verdict = r.verdict;",
    "  out.score = r.scan.score;",
    "  out.checksEvaluated = r.scan.checksEvaluated;",
    '  out.findings = r.scan.findings.map((f) => `${f.checkId} ${f.file ?? ""}`).sort();',
    "} catch (err) { out.error = String(err && err.message ? err.message : err); }",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        PATH: `${npmBin}${delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: tmp,
        OPENA2A_TELEMETRY: "off",
      },
      timeout: 120_000,
    },
  );
  return JSON.parse(stdout.trim().split("\n").pop() as string) as ScanOutcome;
}

describe("the default check's package scan and the scanning user's home directory", () => {
  it(
    "gives the same verdict, score and findings with OpenClaw skills in HOME as without",
    async () => {
      const withoutSkills = await scanPackageWithHome(emptyHome("home-empty"));
      const withSkills = await scanPackageWithHome(homeWithOpenClawSkills("home-openclaw"));

      expect(withoutSkills.error).toBeUndefined();
      expect(withoutSkills.checksEvaluated).toBeGreaterThan(0);
      expect(withSkills.error).toBeUndefined();
      expect(withSkills.findings?.filter((f) => f.includes(".openclaw"))).toEqual([]);
      expect(withSkills).toEqual(withoutSkills);
    },
    240_000,
  );
});
