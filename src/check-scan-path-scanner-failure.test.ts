/**
 * `check --scan-path` when the pinned scanner exits without writing a
 * report: the fix names the scanner and its reinstall, not the directory,
 * which exists and is readable (#226). The directory fix stays for a
 * directory that does not exist.
 *
 * Exercises the built `dist/index.js` end-to-end, from a copy of the package
 * whose node_modules links every dependency except hackmyagent. In its place
 * is a stand-in that answers --version and exits 1 on any other run, having
 * written one line to standard error and nothing to standard output.
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
import { shellArg } from "./utils/shell-arg.js";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

const STAND_IN_SCANNER = [
  'if (process.argv.includes("--version")) {',
  '  process.stdout.write("0.0.0\\n");',
  "  process.exit(0);",
  "}",
  'process.stderr.write("stand-in scanner: exiting without a report\\n");',
  "process.exit(1);",
  "",
].join("\n");

// Empty until installWithStandInScanner() has made the directory.
let scratch = "";
let install = "";

/**
 * A copy of the package in a new directory: package.json, dist, and a
 * node_modules that links every dependency except hackmyagent, which is
 * the stand-in scanner.
 */
function installWithStandInScanner(): void {
  // The real path, so the paths below match the ones the CLI prints.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-scan-path-scanner-")));
  install = join(scratch, "install");
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "fx"));
  writeFileSync(join(scratch, "fx", "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));

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

function checkScanPath(dir: string): { stderr: string; status: number | null } {
  const res = spawnSync(
    process.execPath,
    [join(install, "dist", "index.js"), "check", "fx", "--scan-path", dir, "--no-deep"],
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
  return { stderr: res.stderr ?? "", status: res.status };
}

// Linking a dependency directory on Windows needs a junction.
describe.skipIf(process.platform === "win32")("check --scan-path when the scanner exits without a report", () => {
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

  it("names the scanner and its reinstall, not the directory, and exits 2", () => {
    if (!existsSync(CLI_PATH)) return;
    const dir = join(scratch, "fx");

    const { stderr, status } = checkScanPath(dir);

    expect(stderr).toContain("error: HMA scan failed: Command failed: ");
    expect(stderr).toContain("stand-in scanner: exiting without a report");
    expect(stderr).toContain(
      `Fix: the scanner produced no readable report. Run it directly: npx hackmyagent secure ${shellArg(dir)}\n`,
    );
    expect(stderr).toContain(
      `Or reinstall the hackmyagent copy ai-trust runs: cd ${shellArg(install)} && npm install\n`,
    );
    expect(stderr).not.toContain("Fix: pass --scan-path to a directory that exists and is readable.");
    expect(status).toBe(2);
  });

  it("names the directory, not the scanner, when the directory does not exist", () => {
    if (!existsSync(CLI_PATH)) return;
    const missing = join(scratch, "missing");

    const { stderr, status } = checkScanPath(missing);

    expect(stderr).toContain(`error: ${missing} could not be read (ENOENT).\n`);
    expect(stderr).not.toContain("scanLocalPath");
    expect(stderr).toContain("Fix: pass --scan-path to a directory that exists and is readable.\n");
    expect(stderr).not.toContain("the scanner produced no readable report");
    expect(status).toBe(2);
  });
});
