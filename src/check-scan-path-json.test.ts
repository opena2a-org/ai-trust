/**
 * With `--json`, a `check --scan-path` whose scan fails prints one JSON object
 * with the error on stdout, not text on stderr (#227), and the `fix` of a
 * finding whose fix is `secure --fix` names the scanned directory, as the
 * text output's Fix line does.
 *
 * Exercises the built `dist/index.js` end-to-end, so the object is read from
 * the stdout of a process that has exited.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { shellArg } from "./utils/shell-arg.js";

const CLI_PATH = resolve(__dirname, "../dist/index.js");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-scan-path-json-"));
  mkdirSync(join(scratch, "home"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** `ai-trust --json check fx --scan-path <dir> --no-deep`, run from `cwd` when given. */
function checkScanPathJson(dir: string, cwd?: string) {
  return spawnSync(
    process.execPath,
    [CLI_PATH, "--json", "check", "fx", "--scan-path", dir, "--no-deep"],
    {
      cwd,
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
}

describe("check --scan-path --json with a directory that does not exist", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("prints one JSON object with the error on stdout, nothing on stderr, and exits 2", () => {
    if (!existsSync(CLI_PATH)) return;
    const missing = join(scratch, "missing");

    const res = checkScanPathJson(missing);

    expect(JSON.parse(res.stdout)).toEqual({
      name: "fx",
      found: false,
      error: `${missing} could not be read (ENOENT).`,
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(2);
  }, 30_000);
});

describe("check --scan-path --json on a directory with no .gitignore", () => {
  it("gives the `secure --fix` of the Missing .gitignore finding the scanned directory", () => {
    if (!existsSync(CLI_PATH)) return;
    // One file and no .gitignore: the scanner reports GIT-001, whose fix is
    // `hackmyagent secure --fix`. The scan runs from another directory.
    const dir = join(scratch, "no-gitignore");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.js"), "x=1\n");

    const res = checkScanPathJson(dir, join(scratch, "home"));

    const findings: Array<{ checkId: string; fix?: string }> = JSON.parse(res.stdout).findings;
    const gitignore = findings.find((f) => f.checkId === "GIT-001");
    expect(gitignore?.fix).toBe(`npx hackmyagent secure ${shellArg(dir)} --fix`);
    expect(res.status).toBe(0);
  }, 60_000);
});
