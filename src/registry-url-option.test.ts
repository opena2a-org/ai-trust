/**
 * `--registry-url` with a value that is not an http(s) URL.
 *
 * The registry client refuses such a base URL by throwing a TypeError, and
 * `check`, `audit` and `batch` built the client with the value as given:
 * `ai-trust --registry-url notaurl check openai --no-scan` ended in that
 * TypeError and a stack trace of `node_modules` frames. The value is now
 * checked before any command runs, and the run ends with one line naming the
 * option and an example.
 *
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { registryUrlProblem } from "./utils/registry-url.js";

const CLI_PATH = resolve(__dirname, "../dist/index.js");

const EXPECTED =
  '--registry-url must be an http(s) URL, got "notaurl". Example: --registry-url https://api.oa2a.org';

let scratch: string;
let manifest: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-registry-url-"));
  manifest = join(scratch, "package.json");
  writeFileSync(
    manifest,
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { express: "^4.0.0" } }),
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function isolatedEnv(): NodeJS.ProcessEnv {
  // No host config, no consent file, no telemetry, no provider key.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    OPENA2A_HOME: join(scratch, "home", ".opena2a"),
    XDG_CONFIG_HOME: join(scratch, "home", ".config"),
    NO_COLOR: "1",
    OPENA2A_TELEMETRY: "off",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 20000,
    env: isolatedEnv(),
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

const COMMANDS: Array<{ label: string; args: () => string[] }> = [
  { label: "check", args: () => ["check", "openai", "--no-scan"] },
  { label: "audit", args: () => ["audit", manifest] },
  { label: "batch", args: () => ["batch", "x"] },
];

describe("--registry-url that is not an http(s) URL", () => {
  for (const { label, args } of COMMANDS) {
    it(`${label}: one line on stderr naming the option and an example, exit 1`, () => {
      const res = run(["--registry-url", "notaurl", ...args()]);
      expect(res.stderr).not.toContain("TypeError");
      expect(res.stderr).not.toContain("node_modules");
      expect(res.stderr).toBe(`Error: ${EXPECTED}\n`);
      expect(res.stdout).toBe("");
      expect(res.status).toBe(1);
    });
  }

  it("check --json: an error object on stdout with the same text, nothing on stderr, exit 1", () => {
    const res = run(["--registry-url", "notaurl", "--json", "check", "openai", "--no-scan"]);
    expect(JSON.parse(res.stdout)).toEqual({ error: EXPECTED });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(1);
  });

  it("refuses a URL with a scheme other than http or https", () => {
    const res = run(["--registry-url", "ftp://api.oa2a.org", "batch", "x"]);
    expect(res.stderr).toBe(
      'Error: --registry-url must be an http(s) URL, got "ftp://api.oa2a.org". Example: --registry-url https://api.oa2a.org\n',
    );
    expect(res.status).toBe(1);
  });

  it("prints a value with control characters without them", () => {
    const res = run(["--registry-url", "bad\u009b2Jurl", "batch", "x"]);
    expect(res.stderr).toBe(
      'Error: --registry-url must be an http(s) URL, got "bad2Jurl". Example: --registry-url https://api.oa2a.org\n',
    );
    expect(res.status).toBe(1);
  });
});

describe("registryUrlProblem", () => {
  it("accepts http and https URLs", () => {
    expect(registryUrlProblem("https://api.oa2a.org")).toBeUndefined();
    expect(registryUrlProblem("http://localhost:8080")).toBeUndefined();
  });

  it("refuses a value that does not parse as a URL, an empty one, and other schemes", () => {
    expect(registryUrlProblem("notaurl")).toBe(EXPECTED);
    expect(registryUrlProblem("")).toContain('got "".');
    expect(registryUrlProblem("file:///etc/hosts")).toContain('got "file:///etc/hosts".');
  });
});
