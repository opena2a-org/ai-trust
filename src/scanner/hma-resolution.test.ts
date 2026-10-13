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
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  return compileAiTrust(join(consumer, "node_modules", "ai-trust"));
}

/** Compile hma.ts into `<pkgDir>/dist/scanner/hma.js` of an ai-trust package at `pkgDir`. */
function compileAiTrust(pkgDir: string): string {
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
  nodeBinary: string = process.execPath,
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
    nodeBinary,
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

  it("does not run a hackmyagent that only a symlink in a NODE_PATH folder reaches", async () => {
    // The NODE_PATH folder holds a symlink to a copy elsewhere, the entry
    // `npm link` leaves in npm's global folder.
    const consumer = join(root, "node-path-link");
    const modulePath = installAiTrust(consumer);
    const checkout = join(root, "node-path-link-checkout", "node_modules");
    installScanner(checkout, "linked-copy", 66);
    const globalFolder = join(root, "node-path-link-global", "lib", "node_modules");
    mkdirSync(globalFolder, { recursive: true });
    symlinkSync(join(checkout, "hackmyagent"), join(globalFolder, "hackmyagent"));

    const outcome = await scanFrom(modulePath, pathDecoy("node-path-link"), { NODE_PATH: globalFolder });

    expect(outcome.available).toBe(false);
    expect(outcome.projectType).toBeUndefined();
    expect(outcome.error).toMatch(/global folders/);
    expect(outcome.error).toMatch(/outside the node_modules directories above ai-trust/);
  });

  it("does not run a hackmyagent in a home-directory module folder", async () => {
    const consumer = join(root, "home-folder");
    const modulePath = installAiTrust(consumer);
    const home = join(root, "home-folder-home");
    installScanner(join(home, ".node_modules"), "home-copy", 44);

    const outcome = await scanFrom(modulePath, pathDecoy("home-folder"), { HOME: home });

    expect(outcome.available).toBe(false);
    expect(outcome.projectType).toBeUndefined();
    expect(outcome.error).toMatch(/outside the node_modules directories above ai-trust/);
  });

  it("runs the pinned scanner when node_modules is a symlink to another directory", async () => {
    // A checkout whose node_modules links to a directory outside it.
    const checkout = join(root, "symlinked-node-modules", "ai-trust");
    const target = join(root, "symlinked-node-modules-target", "node_modules");
    installScanner(target, "pinned", 77);
    const modulePath = compileAiTrust(checkout);
    symlinkSync(target, join(checkout, "node_modules"));

    const outcome = await scanFrom(modulePath, pathDecoy("symlinked-node-modules"));

    expect(outcome.error).toBeUndefined();
    expect(outcome.available).toBe(true);
    expect(outcome.projectType).toBe("pinned");
    expect(outcome.score).toBe(77);
  });

  it("runs a pinned scanner that is linked into node_modules (npm link)", async () => {
    const consumer = join(root, "linked");
    const modulePath = installAiTrust(consumer);
    const linkedFrom = join(root, "linked-global", "lib", "node_modules");
    installScanner(linkedFrom, "pinned", 77);
    symlinkSync(join(linkedFrom, "hackmyagent"), join(consumer, "node_modules", "hackmyagent"));

    const outcome = await scanFrom(modulePath, pathDecoy("linked"));

    expect(outcome.error).toBeUndefined();
    expect(outcome.available).toBe(true);
    expect(outcome.projectType).toBe("pinned");
    expect(outcome.score).toBe(77);
  });

  it("runs a pinned scanner that a patched resolver returns from outside node_modules (Plug'n'Play)", async () => {
    // Yarn Plug'n'Play has no node_modules: it patches Node's resolver to
    // answer from its own cache. A resolver hook that does the same returns a
    // copy laid out the way the Plug'n'Play cache lays it out.
    const project = join(root, "pnp");
    const modulePath = compileAiTrust(join(project, "ai-trust"));
    const cacheEntry = join(project, ".yarn", "cache", "hackmyagent-npm-0.0.0-test.zip");
    installScanner(join(cacheEntry, "node_modules"), "pinned", 77);
    const hook = join(project, "resolver-hook.cjs");
    writeFileSync(
      hook,
      [
        'const Module = require("node:module");',
        "const original = Module._resolveFilename;",
        "Module._resolveFilename = function (request, ...rest) {",
        `  if (request === "hackmyagent") return ${JSON.stringify(join(cacheEntry, "node_modules", "hackmyagent", "dist", "index.js"))};`,
        "  return original.call(this, request, ...rest);",
        "};",
        "",
      ].join("\n"),
    );

    const outcome = await scanFrom(modulePath, pathDecoy("pnp"), { NODE_OPTIONS: `--require ${hook}` });

    expect(outcome.error).toBeUndefined();
    expect(outcome.available).toBe(true);
    expect(outcome.projectType).toBe("pinned");
    expect(outcome.score).toBe(77);
  });

  it("does not run a hackmyagent in Node's <prefix>/lib/node folder", async () => {
    // Node derives <prefix> from the directory above its own binary, so a
    // copy of the binary under <prefix>/bin makes <prefix>/lib/node a global
    // folder of that Node.
    const consumer = join(root, "prefix-folder");
    const modulePath = installAiTrust(consumer);
    const prefix = join(root, "prefix-folder-prefix");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib"), { recursive: true });
    const nodeBinary = join(prefix, "bin", "node");
    copyFileSync(process.execPath, nodeBinary, fsConstants.COPYFILE_FICLONE);
    chmodSync(nodeBinary, 0o755);
    // A Node built to load its own shared library from <prefix>/lib finds it
    // from the copy too.
    const realLib = join(dirname(dirname(realpathSync(process.execPath))), "lib");
    if (existsSync(realLib)) {
      for (const name of readdirSync(realLib)) {
        if (name !== "node") symlinkSync(join(realLib, name), join(prefix, "lib", name));
      }
    }
    installScanner(join(prefix, "lib", "node"), "prefix-copy", 55);

    const outcome = await scanFrom(modulePath, pathDecoy("prefix-folder"), {}, nodeBinary);

    expect(outcome.available).toBe(false);
    expect(outcome.projectType).toBeUndefined();
    expect(outcome.error).toMatch(/global folders/);
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
