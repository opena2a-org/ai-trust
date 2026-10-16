/**
 * Tests for HMA subprocess runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: vi.fn((fn: unknown) => fn),
  };
});

import { execFile } from "node:child_process";
import { isHmaAvailable, runHmaScan, scannerTempDirProblem } from "./hma.js";

describe("isHmaAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the pinned hackmyagent --version succeeds", async () => {
    vi.mocked(execFile as any).mockResolvedValue({
      stdout: "0.10.2",
      stderr: "",
    });

    const result = await isHmaAvailable();
    expect(result).toBe(true);
  });

  it("returns false when the pinned hackmyagent fails", async () => {
    vi.mocked(execFile as any).mockRejectedValue(
      new Error("not found")
    );

    const result = await isHmaAvailable();
    expect(result).toBe(false);
  });
});

describe("runHmaScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid HMA JSON output", async () => {
    const hmaOutput = JSON.stringify({
      score: 85,
      maxScore: 100,
      projectType: "mcp",
      timestamp: "2026-03-14T00:00:00Z",
      findings: [
        {
          checkId: "SEC-001",
          name: "No .env exposure",
          description: "Check for exposed env files",
          category: "secrets",
          severity: "high",
          passed: true,
          message: "No .env files found",
        },
        {
          checkId: "SEC-002",
          name: "Hardcoded key",
          description: "Check for hardcoded keys",
          category: "secrets",
          severity: "critical",
          passed: false,
          message: "Found API key in config.js",
          file: "config.js",
          line: 42,
          fix: "Use environment variables",
        },
      ],
    });

    vi.mocked(execFile as any).mockResolvedValue({
      stdout: hmaOutput,
      stderr: "",
    });

    const result = await runHmaScan("/tmp/test-pkg");

    expect(result.score).toBe(85);
    expect(result.maxScore).toBe(100);
    expect(result.projectType).toBe("mcp");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1].passed).toBe(false);
    expect(result.findings[1].severity).toBe("critical");
  });

  it("handles HMA exit code 1 with valid JSON in stdout", async () => {
    const hmaOutput = JSON.stringify({
      score: 30,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-003",
          name: "Critical issue",
          severity: "critical",
          passed: false,
          message: "Bad stuff found",
        },
      ],
    });

    const error = new Error("Process exited with code 1");
    (error as any).stdout = hmaOutput;
    (error as any).stderr = "";
    vi.mocked(execFile as any).mockRejectedValue(error);

    const result = await runHmaScan("/tmp/test-pkg");

    expect(result.score).toBe(30);
    expect(result.findings).toHaveLength(1);
  });

  describe("--deep / --no-deep", () => {
    const hmaJson = JSON.stringify({ score: 75, maxScore: 100, findings: [] });

    /** Arguments of every `secure` invocation, in call order. */
    function secureCallArgs(): string[][] {
      return vi
        .mocked(execFile as any)
        .mock.calls.map((call: unknown[]) => call[1] as string[])
        .filter((args: string[]) => args.includes("secure"));
    }

    it("passes --deep and not --static-only by default", async () => {
      vi.mocked(execFile as any).mockResolvedValue({ stdout: hmaJson, stderr: "" });

      await runHmaScan("/tmp/test-pkg");

      const [args] = secureCallArgs();
      expect(args).toContain("--deep");
      expect(args).not.toContain("--static-only");
    });

    it("passes --static-only and not --deep when deep is false", async () => {
      vi.mocked(execFile as any).mockResolvedValue({ stdout: hmaJson, stderr: "" });

      await runHmaScan("/tmp/test-pkg", { deep: false });

      const [args] = secureCallArgs();
      expect(args).toContain("--static-only");
      expect(args).not.toContain("--deep");
      expect(args[args.length - 1]).toBe("/tmp/test-pkg");
    });

    it("retries without --static-only when an older HMA rejects it", async () => {
      vi.mocked(execFile as any).mockImplementation(
        async (_cmd: string, args: string[]) => {
          if (args.includes("secure") && args.includes("--static-only")) {
            const error = new Error(
              "Command failed: hackmyagent secure\nerror: unknown option '--static-only'\n"
            );
            (error as any).stdout = "";
            throw error;
          }
          return { stdout: hmaJson, stderr: "" };
        }
      );

      const result = await runHmaScan("/tmp/test-pkg", { deep: false });

      expect(result.score).toBe(75);
      const calls = secureCallArgs();
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toContain("--static-only");
      expect(calls[1]).not.toContain("--deep");
    });
  });

  it("throws when HMA produces no JSON", async () => {
    vi.mocked(execFile as any).mockResolvedValue({
      stdout: "Some non-JSON output\nAnother line\n",
      stderr: "",
    });

    await expect(runHmaScan("/tmp/test-pkg")).rejects.toThrow(
      "No JSON output"
    );
  });

  it("handles JSON output preceded by non-JSON lines", async () => {
    const hmaOutput = `Loading checks...
Running 147 checks...
${JSON.stringify({
  score: 92,
  maxScore: 100,
  findings: [],
  projectType: "library",
})}`;

    vi.mocked(execFile as any).mockResolvedValue({
      stdout: hmaOutput,
      stderr: "",
    });

    const result = await runHmaScan("/tmp/test-pkg");
    expect(result.score).toBe(92);
    expect(result.findings).toHaveLength(0);
  });
});

describe("runHmaScan contribution", () => {
  const scanJson = JSON.stringify({
    score: 100,
    maxScore: 100,
    findings: [],
    projectType: "library",
  });

  function secureCalls(): string[][] {
    return vi
      .mocked(execFile as any)
      .mock.calls.map((c: unknown[]) => c[1] as string[])
      .filter((args: string[]) => args.includes("secure"));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The HMA subprocess must never decide about contribution on its own:
  // without --no-contribute it falls back to ~/.opena2a/config.json and
  // queues a scan_result even when the user passed `--no-contribute`.
  it.each([
    ["default options", {}],
    ["static-only scan", { deep: false }],
    ["AnaLM scan", { analm: true }],
  ])("passes --no-contribute to hackmyagent secure (%s)", async (_label, options) => {
    vi.mocked(execFile as any).mockResolvedValue({ stdout: scanJson, stderr: "" });

    await runHmaScan("/tmp/test-pkg", options);

    const calls = secureCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--no-contribute");
    expect(calls[0]).not.toContain("--contribute");
    expect(calls[0][calls[0].length - 1]).toBe("/tmp/test-pkg");
  });

  it("keeps --no-contribute when retrying without --analm on an older HMA", async () => {
    vi.mocked(execFile as any).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("--analm")) {
          // Node's execFile error message carries the subprocess stderr.
          const stderr = "error: unknown option '--analm'";
          throw Object.assign(
            new Error(`Command failed: hackmyagent ${args.join(" ")}\n${stderr}`),
            { stdout: "", stderr },
          );
        }
        return { stdout: scanJson, stderr: "" };
      },
    );

    const result = await runHmaScan("/tmp/test-pkg", { analm: true });

    expect(result.score).toBe(100);
    const calls = secureCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain("--analm");
    expect(calls[1]).toContain("--no-contribute");
  });
});

// The scanner reads, rewrites and acts on the saved contribution choice in
// ~/.opena2a/config.json and ~/.hackmyagent/config.json, and sends usage
// telemetry unless told not to. It runs with those files out of reach and its
// telemetry off. hma-saved-state.test.ts runs the real scanner over every
// combination of saved values and flags.
describe("scanner environment", () => {
  const scanJson = JSON.stringify({ score: 100, maxScore: 100, findings: [] });
  let tempHome: string;
  let savedEnv: Record<string, string | undefined>;
  const VARS = [
    "HOME",
    "USERPROFILE",
    "OPENA2A_HOME",
    "XDG_CONFIG_HOME",
    "OPENA2A_TELEMETRY",
    "ANTHROPIC_API_KEY",
    "anthropic_api_key",
  ];

  /** The environment of each scanner invocation, with what it saw of its home. */
  let seen: { args: string[]; env: NodeJS.ProcessEnv; models: string[]; savedChoice: boolean }[];

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = mkdtempSync(join(tmpdir(), "ai-trust-hma-env-"));
    savedEnv = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    seen = [];
    vi.mocked(execFile as any).mockImplementation(
      async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        const home = opts.env.HOME as string;
        seen.push({
          args,
          env: opts.env,
          models: [
            join(home, ".nanomind", "models", "a.onnx"),
            join(home, ".opena2a", "nanomind", "models", "b.onnx"),
          ]
            .filter((f) => existsSync(f))
            .map((f) => readFileSync(f, "utf8")),
          savedChoice: existsSync(join(opts.env.OPENA2A_HOME as string, "config.json")),
        });
        return { stdout: scanJson, stderr: "" };
      },
    );
  });

  afterEach(() => {
    for (const v of VARS) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("runs secure with its home in a new temporary directory and its telemetry off", async () => {
    process.env.OPENA2A_HOME = join(tempHome, "custom");
    process.env.XDG_CONFIG_HOME = join(tempHome, "config");

    await runHmaScan("/tmp/test-pkg");

    expect(seen).toHaveLength(1);
    const { env } = seen[0];
    const home = env.HOME as string;
    expect(home).not.toBe(tempHome);
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(env.USERPROFILE).toBe(home);
    expect(env.OPENA2A_HOME).toBe(join(home, ".opena2a"));
    expect(env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
    expect(env.OPENA2A_TELEMETRY).toBe("off");
    // Removed after the run.
    expect(existsSync(home)).toBe(false);
  });

  it("marks a no saved by ai-trust 0.7.6 before the scan (#133)", async () => {
    const configPath = join(tempHome, ".opena2a", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
        telemetry: { scanCount: 2, contributePromptDismissedAt: "2026-06-20T10:00:00.000Z" },
      }),
    );
    let savedWhenScanned: unknown;
    vi.mocked(execFile as any).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("secure")) {
        savedWhenScanned = JSON.parse(readFileSync(configPath, "utf8")).contribute;
      }
      return { stdout: scanJson, stderr: "" };
    });

    await runHmaScan("/tmp/test-pkg");

    expect(savedWhenScanned).toMatchObject({
      enabled: false,
      decidedAt: "2026-06-20T10:00:00.000Z",
    });
  });

  it("runs the --version check the same way", async () => {
    expect(await isHmaAvailable()).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0].args).toContain("--version");
    expect(seen[0].env.HOME).not.toBe(tempHome);
    expect(seen[0].env.OPENA2A_TELEMETRY).toBe("off");
    expect(existsSync(seen[0].env.HOME as string)).toBe(false);
  });

  it("runs secure and the --version check without ANTHROPIC_API_KEY, while ai-trust keeps it", async () => {
    const placeholder = `placeholder-${randomUUID()}`;
    process.env.ANTHROPIC_API_KEY = placeholder;

    await runHmaScan("/tmp/test-pkg");
    expect(await isHmaAvailable()).toBe(true);

    expect(seen.map((s) => s.args.includes("secure"))).toEqual([true, false]);
    // Filtered first, so a failure prints no other variable's name or value.
    for (const { env } of seen) {
      expect(Object.keys(env).filter((k) => k === "ANTHROPIC_API_KEY")).toEqual([]);
      expect(Object.values(env).filter((v) => v === placeholder)).toEqual([]);
      // The rest of ai-trust's environment reaches the scanner.
      expect(env.PATH === process.env.PATH).toBe(true);
    }
    // Only the scanner's copy goes without it.
    expect(process.env.ANTHROPIC_API_KEY).toBe(placeholder);
  });

  it("runs the scanner without ANTHROPIC_API_KEY in another letter case, which Windows reads as the same name", async () => {
    const placeholder = `placeholder-${randomUUID()}`;
    process.env.anthropic_api_key = placeholder;

    await runHmaScan("/tmp/test-pkg");

    expect(Object.keys(seen[0].env).filter((k) => k.toUpperCase() === "ANTHROPIC_API_KEY")).toEqual([]);
    expect(Object.values(seen[0].env).filter((v) => v === placeholder)).toEqual([]);
  });

  it("gives each run a home of its own", async () => {
    await runHmaScan("/tmp/test-pkg");
    await runHmaScan("/tmp/test-pkg");

    expect(seen[0].env.HOME).not.toBe(seen[1].env.HOME);
  });

  it("finds the classifier models in ~/.nanomind and ~/.opena2a/nanomind and leaves them in place", async () => {
    mkdirSync(join(tempHome, ".nanomind", "models"), { recursive: true });
    writeFileSync(join(tempHome, ".nanomind", "models", "a.onnx"), "model a");
    mkdirSync(join(tempHome, ".opena2a", "nanomind", "models"), { recursive: true });
    writeFileSync(join(tempHome, ".opena2a", "nanomind", "models", "b.onnx"), "model b");
    writeFileSync(join(tempHome, ".opena2a", "config.json"), JSON.stringify({ contribute: { enabled: true } }));

    await runHmaScan("/tmp/test-pkg");

    expect(seen[0].models).toEqual(["model a", "model b"]);
    expect(seen[0].savedChoice).toBe(false);
    expect(readFileSync(join(tempHome, ".nanomind", "models", "a.onnx"), "utf8")).toBe("model a");
    expect(readFileSync(join(tempHome, ".opena2a", "nanomind", "models", "b.onnx"), "utf8")).toBe("model b");
    expect(readFileSync(join(tempHome, ".opena2a", "config.json"), "utf8")).toContain("true");
  });

  it("creates ~/.nanomind, so a model the scanner downloads stays in the user's home", async () => {
    await runHmaScan("/tmp/test-pkg");

    expect(existsSync(join(tempHome, ".nanomind"))).toBe(true);
  });

  it("removes the temporary home when the scan fails", async () => {
    vi.mocked(execFile as any).mockImplementation(
      async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        seen.push({ args, env: opts.env, models: [], savedChoice: false });
        throw new Error("scanner crashed");
      },
    );

    await expect(runHmaScan("/tmp/test-pkg")).rejects.toThrow("HMA scan failed");
    expect(existsSync(seen[0].env.HOME as string)).toBe(false);
  });
});

// os.tmpdir() reads TMPDIR on every platform but Windows.
describe.skipIf(process.platform === "win32")("a temporary directory that cannot hold the scanner's home", () => {
  const VARS = ["TMPDIR", "HOME", "USERPROFILE", "OPENA2A_HOME"];
  let scratch: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFile as any).mockResolvedValue({ stdout: "0.33.2\n", stderr: "" });
    scratch = mkdtempSync(join(tmpdir(), "ai-trust-hma-tmpdir-"));
    savedEnv = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    delete process.env.OPENA2A_HOME;
    process.env.HOME = join(scratch, "home");
    process.env.USERPROFILE = join(scratch, "home");
    mkdirSync(join(scratch, "home"));
  });

  afterEach(() => {
    for (const v of VARS) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("names a TMPDIR that does not exist, and the scanner is not run", async () => {
    const missing = join(scratch, "missing");
    process.env.TMPDIR = missing;

    expect(scannerTempDirProblem()).toBe(
      `ai-trust runs the scanner with a new temporary home directory and could not create one in ${missing} (ENOENT). Point TMPDIR at a directory that exists and that you can write to, for example: export TMPDIR=/tmp`,
    );
    expect(await isHmaAvailable()).toBe(false);
    await expect(runHmaScan("/tmp/test-pkg")).rejects.toThrow(
      `could not create one in ${missing} (ENOENT)`,
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("names a TMPDIR that is a file", () => {
    const file = join(scratch, "a-file");
    writeFileSync(file, "");
    process.env.TMPDIR = file;

    expect(scannerTempDirProblem()).toContain(`could not create one in ${file} (ENOTDIR)`);
  });

  it("finds no problem in a writable TMPDIR, and leaves nothing in it", async () => {
    const writable = join(scratch, "tmp");
    mkdirSync(writable);
    process.env.TMPDIR = writable;

    expect(scannerTempDirProblem()).toBeNull();
    expect(readdirSync(writable)).toEqual([]);
    expect(await isHmaAvailable()).toBe(true);
  });
});
