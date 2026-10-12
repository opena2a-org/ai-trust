/**
 * Which scanner runs in a consumer install.
 *
 * ai-trust pins `hackmyagent` exactly. In a consumer install npm hoists that
 * dependency to the consumer's top-level node_modules, so there is no
 * `node_modules/ai-trust/node_modules/.bin/hackmyagent`. These tests compile
 * the real `hma.ts` into a fake install tree, put a different `hackmyagent`
 * first on PATH, and assert that the copy Node resolves for ai-trust is the
 * one that runs, and that nothing on PATH is used in its place.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { reinstallCommand } from "./hma.js";

const execFileAsync = promisify(execFile);

const HMA_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "hma.ts");

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hma-resolution-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A node script that answers `--version` and `secure --format json`. */
function scannerScript(label: string, score: number): string {
  return [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    `if (args.includes("--version")) { console.log(${JSON.stringify(label)}); process.exit(0); }`,
    `console.log(JSON.stringify({ score: ${score}, maxScore: 100, projectType: ${JSON.stringify(label)}, timestamp: "2026-01-01T00:00:00Z", findings: [] }));`,
    "",
  ].join("\n");
}

/** Install a fake `hackmyagent` package, laid out the way npm lays it out. */
function installScanner(nodeModules: string, label: string, score: number): void {
  const pkgDir = join(nodeModules, "hackmyagent");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "hackmyagent",
      version: label,
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
      bin: { hackmyagent: "dist/cli.js" },
    }),
  );
  writeFileSync(join(pkgDir, "dist", "index.js"), "module.exports = {};\n");
  writeFileSync(join(pkgDir, "dist", "cli.js"), scannerScript(label, score));
  chmodSync(join(pkgDir, "dist", "cli.js"), 0o755);
  mkdirSync(join(nodeModules, ".bin"), { recursive: true });
  symlinkSync("../hackmyagent/dist/cli.js", join(nodeModules, ".bin", "hackmyagent"));
}

/** Compile hma.ts into `<consumer>/node_modules/ai-trust/dist/scanner/hma.js`. */
function installAiTrust(consumer: string): string {
  const pkgDir = join(consumer, "node_modules", "ai-trust");
  mkdirSync(join(pkgDir, "dist", "scanner"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "ai-trust", version: "0.0.0-test", type: "module" }),
  );
  const { outputText } = ts.transpileModule(readFileSync(HMA_SOURCE, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const modulePath = join(pkgDir, "dist", "scanner", "hma.js");
  writeFileSync(modulePath, outputText);
  return modulePath;
}

/** A `hackmyagent` executable on PATH that is not the pinned dependency. */
function pathDecoy(name: string): string {
  const dir = join(root, name, "path-bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hackmyagent"), scannerScript("path-decoy", 11));
  chmodSync(join(dir, "hackmyagent"), 0o755);
  return dir;
}

interface ScanOutcome {
  available: boolean;
  score?: number;
  projectType?: string;
  error?: string;
}

async function scanFrom(
  modulePath: string,
  decoyDir: string,
  extraEnv: Record<string, string> = {},
): Promise<ScanOutcome> {
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const script = [
    `const hma = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    "const out = { available: await hma.isHmaAvailable() };",
    "try {",
    `  const r = await hma.runHmaScan(${JSON.stringify(target)}, { deep: false });`,
    "  out.score = r.score; out.projectType = r.projectType;",
    "} catch (err) { out.error = String(err && err.message ? err.message : err); }",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: { ...process.env, PATH: `${decoyDir}:${process.env.PATH ?? ""}`, ...extraEnv },
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout.trim().split("\n").pop() as string) as ScanOutcome;
}

describe("scanner resolution in a consumer install", () => {
  it("runs the hoisted pinned scanner, not the hackmyagent first on PATH", async () => {
    const consumer = join(root, "hoisted");
    installScanner(join(consumer, "node_modules"), "pinned", 77);
    const modulePath = installAiTrust(consumer);

    const outcome = await scanFrom(modulePath, pathDecoy("hoisted"));

    expect(outcome.error).toBeUndefined();
    expect(outcome.available).toBe(true);
    expect(outcome.projectType).toBe("pinned");
    expect(outcome.score).toBe(77);
  });

  it("runs the copy nested under ai-trust when the hoisted copy is another version", async () => {
    const consumer = join(root, "nested");
    installScanner(join(consumer, "node_modules"), "hoisted-other", 33);
    installScanner(join(consumer, "node_modules", "ai-trust", "node_modules"), "pinned", 77);
    const modulePath = installAiTrust(consumer);

    const outcome = await scanFrom(modulePath, pathDecoy("nested"));

    expect(outcome.error).toBeUndefined();
    expect(outcome.projectType).toBe("pinned");
    expect(outcome.score).toBe(77);
  });

  it("does not fall back to PATH when the pinned scanner is not installed", async () => {
    const consumer = join(root, "missing");
    const modulePath = installAiTrust(consumer);

    const outcome = await scanFrom(modulePath, pathDecoy("missing"));

    expect(outcome.available).toBe(false);
    expect(outcome.projectType).toBeUndefined();
    expect(outcome.error).toMatch(/hackmyagent/);
  });

  it("does not run a hackmyagent that only NODE_PATH reaches", async () => {
    const consumer = join(root, "node-path");
    const modulePath = installAiTrust(consumer);
    const elsewhere = join(root, "node-path-elsewhere", "node_modules");
    installScanner(elsewhere, "node-path-copy", 22);

    const outcome = await scanFrom(modulePath, pathDecoy("node-path"), { NODE_PATH: elsewhere });

    expect(outcome.available).toBe(false);
    expect(outcome.projectType).toBeUndefined();
    expect(outcome.error).toMatch(/outside the node_modules directories above ai-trust/);
  });
});

describe("reinstall command for a missing scanner", () => {
  /** Lay out an ai-trust package at `pkgDir` and return its dist/scanner directory. */
  function aiTrustAt(pkgDir: string): string {
    const scannerDir = join(pkgDir, "dist", "scanner");
    mkdirSync(scannerDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "ai-trust" }));
    return scannerDir;
  }

  function project(dir: string, name: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  }

  it("names a global reinstall for a global install", () => {
    const from = aiTrustAt(join(root, "reinstall-global", "lib", "node_modules", "ai-trust"));
    expect(reinstallCommand(from)).toBe("npm install -g ai-trust");
  });

  it("names `npm install` in the project for a project dependency", () => {
    const app = join(root, "reinstall-project", "app");
    project(app, "app");
    const from = aiTrustAt(join(app, "node_modules", "ai-trust"));
    expect(reinstallCommand(from)).toBe(`cd ${app} && npm install`);
  });

  it("names the opena2a-cli reinstall when ai-trust is installed under a global opena2a-cli", () => {
    const cli = join(root, "reinstall-cli", "lib", "node_modules", "opena2a-cli");
    project(cli, "opena2a-cli");
    const from = aiTrustAt(join(cli, "node_modules", "ai-trust"));
    expect(reinstallCommand(from)).toBe("npm install -g opena2a-cli");
  });

  it("names `npm install` in the project when opena2a-cli is a project dependency", () => {
    const app = join(root, "reinstall-cli-project", "my app");
    project(app, "app");
    const cli = join(app, "node_modules", "@opena2a", "cli");
    project(cli, "@opena2a/cli");
    const from = aiTrustAt(join(cli, "node_modules", "ai-trust"));
    expect(reinstallCommand(from)).toBe(`cd '${app}' && npm install`);
  });

  it("names `npm install` in a source checkout", () => {
    const checkout = join(root, "reinstall-checkout", "ai-trust");
    const from = aiTrustAt(checkout);
    expect(reinstallCommand(from)).toBe(`cd ${checkout} && npm install`);
  });
});
