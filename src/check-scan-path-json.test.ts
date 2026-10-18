/**
 * With `--json`, a `check --scan-path` whose scan fails prints one JSON object
 * with the error on stdout, not text on stderr (#227).
 *
 * Exercises the built `dist/index.js` end-to-end, so the object is read from
 * the stdout of a process that has exited.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-scan-path-json-"));
  mkdirSync(join(scratch, "home"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("check --scan-path --json with a directory that does not exist", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("prints one JSON object with the error on stdout, nothing on stderr, and exits 2", () => {
    if (!existsSync(CLI_PATH)) return;
    const missing = join(scratch, "missing");

    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "--json", "check", "fx", "--scan-path", missing, "--no-deep"],
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

    expect(JSON.parse(res.stdout)).toEqual({
      name: "fx",
      found: false,
      error: `scanLocalPath: ${missing} could not be read (ENOENT).`,
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(2);
  }, 30_000);
});
