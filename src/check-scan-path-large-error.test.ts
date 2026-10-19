/**
 * `check --scan-path` whose scan fails with an error larger than the pipe
 * buffer prints the whole error (#234). The catch around scanLocalPath
 * printed the error and called process.exit(2) on the next line; on macOS a
 * write from process.stdout or process.stderr to a pipe is asynchronous, so
 * the process ended with the rest unwritten: with --json the object on
 * stdout was cut off and did not parse, and without --json the text on
 * stderr ended inside the message, before the Fix lines. Node documents a
 * write to a pipe as synchronous on Linux and asynchronous on macOS and
 * Windows; the measurement behind this test was made on macOS.
 *
 * Exercises the built `dist/index.js` end-to-end, from a copy of the package
 * whose node_modules links every dependency except hackmyagent. In its place
 * is a stand-in that answers --version and, on any other run, writes 400000
 * bytes to standard error and exits 1 having written nothing to standard
 * output, so the error the scan fails with carries those bytes.
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

/** Bytes the stand-in scanner writes to standard error: more than one pipe buffer. */
const SCANNER_STDERR_BYTES = 400_000;
const SCANNER_STDERR = "e".repeat(SCANNER_STDERR_BYTES);

const STAND_IN_SCANNER = [
  'if (process.argv.includes("--version")) {',
  '  process.stdout.write("0.0.0\\n");',
  "  process.exit(0);",
  "}",
  // Exits once the bytes are written, so the stand-in itself drops none.
  `process.stderr.write("e".repeat(${SCANNER_STDERR_BYTES}), () => process.exit(1));`,
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-scan-path-large-error-")));
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

/** Run `check fx --scan-path <dir> --no-deep`, with --json when asked, stdout and stderr piped. */
function checkScanPath(dir: string, json: boolean): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(
    process.execPath,
    [join(install, "dist", "index.js"), ...(json ? ["--json"] : []), "check", "fx", "--scan-path", dir, "--no-deep"],
    {
      encoding: "utf8",
      timeout: 60_000,
      // The error carries the scanner's 400000 bytes; the default is 1 MiB.
      maxBuffer: 16 * 1024 * 1024,
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
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

/** Whether the text carries the scanner's whole standard error. */
function carriesScannerStderr(text: string): boolean {
  return text.includes(SCANNER_STDERR);
}

// Linking a dependency directory on Windows needs a junction.
describe.skipIf(process.platform === "win32")("check --scan-path with a scan error larger than the pipe buffer", () => {
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

  it("with --json prints the whole object on stdout, nothing on stderr, and exits 2", () => {
    if (!existsSync(CLI_PATH)) return;

    const { stdout, stderr, status } = checkScanPath(join(scratch, "fx"), true);

    // Cut off at the pipe buffer, the object is shorter than the error alone.
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(SCANNER_STDERR_BYTES);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(["error", "found", "name"]);
    expect(parsed.name).toBe("fx");
    expect(parsed.found).toBe(false);
    expect(parsed.error.startsWith("HMA scan failed: Command failed: ")).toBe(true);
    expect(carriesScannerStderr(parsed.error)).toBe(true);
    expect(stderr).toBe("");
    expect(status).toBe(2);
  });

  it("without --json prints the whole error and the fix lines after it on stderr, nothing on stdout, and exits 2", () => {
    if (!existsSync(CLI_PATH)) return;
    const dir = join(scratch, "fx");

    const { stdout, stderr, status } = checkScanPath(dir, false);

    // Cut off at the pipe buffer, the text is shorter than the error alone.
    expect(Buffer.byteLength(stderr)).toBeGreaterThan(SCANNER_STDERR_BYTES);
    expect(stderr.startsWith("error: HMA scan failed: Command failed: ")).toBe(true);
    expect(carriesScannerStderr(stderr)).toBe(true);
    expect(stderr).toContain(
      `\nFix: the scanner produced no readable report. Run it directly: npx hackmyagent secure ${shellArg(dir)}\n`,
    );
    expect(stderr).toContain(
      `Or reinstall the hackmyagent copy ai-trust runs: cd ${shellArg(install)} && npm install\n`,
    );
    expect(stdout).toBe("");
    expect(status).toBe(2);
  });
});
