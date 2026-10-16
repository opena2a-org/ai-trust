/**
 * `check --scan-path` with a TMPDIR the scanner's temporary home cannot be
 * created in: the error names that directory and TMPDIR, not a reinstall.
 *
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-scan-path-tmpdir-"));
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "fx"));
  writeFileSync(join(scratch, "fx", "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function checkScanPath(tmpDir: string): { stderr: string; status: number | null } {
  const res = spawnSync(
    process.execPath,
    [CLI_PATH, "check", "fx", "--scan-path", join(scratch, "fx"), "--no-deep"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "home", ".config"),
        TMPDIR: tmpDir,
        NO_COLOR: "1",
        CI: "true",
        OPENA2A_TELEMETRY: "off",
      },
    },
  );
  return { stderr: res.stderr ?? "", status: res.status };
}

// os.tmpdir() reads TMPDIR on every platform but Windows.
describe.skipIf(process.platform === "win32")("check --scan-path with an unusable TMPDIR", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("names a TMPDIR that does not exist and says to point TMPDIR at a writable directory", () => {
    if (!existsSync(CLI_PATH)) return;
    const missing = join(scratch, "missing");

    const { stderr, status } = checkScanPath(missing);

    expect(stderr).toContain(
      `error: HMA could not be started. ai-trust runs the scanner with a new temporary home directory and could not create one in ${missing} (ENOENT). Point TMPDIR at a directory that exists and that you can write to, for example: export TMPDIR=/tmp`,
    );
    expect(stderr).not.toContain("Reinstall");
    expect(status).toBe(2);
  });
});
