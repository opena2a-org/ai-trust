/**
 * Tests for HMA subprocess runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { hmaEnv, isHmaAvailable, runHmaScan } from "./hma.js";

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

// HMA gates its NanoMind classification telemetry on its own reading of the
// saved contribution choice. Through @opena2a/shared that reading is the
// saved value as it is, so a string such as "false" passed the gate while
// ai-trust read the same file as no choice (#147).
describe("runHmaScan scanner environment", () => {
  const scanJson = JSON.stringify({ score: 100, maxScore: 100, findings: [] });
  let tempHome: string;
  let savedHome: string | undefined;
  let savedOpena2aHome: string | undefined;

  function saveChoice(dir: string, enabled: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ contribute: { enabled } }));
  }

  /** HMA's legacy config, whose `"contribute": true` a `secure` run moves into ~/.opena2a. */
  function saveLegacyChoice(contribute: unknown): void {
    mkdirSync(join(tempHome, ".hackmyagent"), { recursive: true });
    writeFileSync(join(tempHome, ".hackmyagent", "config.json"), JSON.stringify({ contribute }));
  }

  /** The environment of the `secure` invocation. */
  function secureEnv(): NodeJS.ProcessEnv | undefined {
    const call = vi
      .mocked(execFile as any)
      .mock.calls.find((c: unknown[]) => (c[1] as string[]).includes("secure"));
    return (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = mkdtempSync(join(tmpdir(), "ai-trust-hma-env-"));
    savedHome = process.env.HOME;
    savedOpena2aHome = process.env.OPENA2A_HOME;
    process.env.HOME = tempHome;
    delete process.env.OPENA2A_HOME;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedOpena2aHome === undefined) delete process.env.OPENA2A_HOME;
    else process.env.OPENA2A_HOME = savedOpena2aHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it.each(["false", "true", 1])(
    "runs HMA with OPENA2A_HOME set to ~/.opena2a when the saved enabled is %j",
    async (value) => {
      saveChoice(join(tempHome, ".opena2a"), value);
      vi.mocked(execFile as any).mockResolvedValue({ stdout: scanJson, stderr: "" });

      await runHmaScan("/tmp/test-pkg");

      const env = secureEnv();
      expect(env?.OPENA2A_HOME).toBe(join(tempHome, ".opena2a"));
      expect(env?.HOME).toBe(tempHome);
    },
  );

  it.each([true, false, 0, null])(
    "leaves OPENA2A_HOME unset when the saved enabled is %j",
    async (value) => {
      saveChoice(join(tempHome, ".opena2a"), value);
      vi.mocked(execFile as any).mockResolvedValue({ stdout: scanJson, stderr: "" });

      await runHmaScan("/tmp/test-pkg");

      expect(secureEnv()).toBeDefined();
      expect(secureEnv()?.OPENA2A_HOME).toBeUndefined();
    },
  );

  it.each(["false", "true", 1])(
    "leaves OPENA2A_HOME unset when the saved enabled is %j and ~/.hackmyagent/config.json holds \"contribute\": true",
    async (value) => {
      saveChoice(join(tempHome, ".opena2a"), value);
      saveLegacyChoice(true);
      vi.mocked(execFile as any).mockResolvedValue({ stdout: scanJson, stderr: "" });

      await runHmaScan("/tmp/test-pkg");

      expect(secureEnv()).toBeDefined();
      expect(secureEnv()?.OPENA2A_HOME).toBeUndefined();
    },
  );

  it("sets OPENA2A_HOME when ~/.hackmyagent/config.json holds \"contribute\": false", () => {
    saveChoice(join(tempHome, ".opena2a"), "false");
    saveLegacyChoice(false);
    expect(hmaEnv().OPENA2A_HOME).toBe(join(tempHome, ".opena2a"));
  });

  it("sets OPENA2A_HOME when ~/.hackmyagent/config.json does not parse", () => {
    saveChoice(join(tempHome, ".opena2a"), "false");
    mkdirSync(join(tempHome, ".hackmyagent"), { recursive: true });
    writeFileSync(join(tempHome, ".hackmyagent", "config.json"), "{\"contribute\": true");
    expect(hmaEnv().OPENA2A_HOME).toBe(join(tempHome, ".opena2a"));
  });

  it("leaves OPENA2A_HOME unset when no config file exists", () => {
    expect(hmaEnv().OPENA2A_HOME).toBeUndefined();
  });

  it("keeps an OPENA2A_HOME that is already set", () => {
    const custom = join(tempHome, "custom");
    saveChoice(custom, "false");
    process.env.OPENA2A_HOME = custom;
    expect(hmaEnv().OPENA2A_HOME).toBe(custom);
  });

  describe("with the pinned hackmyagent", () => {
    const telemetryModule = join(
      dirname(createRequire(import.meta.url).resolve("hackmyagent")),
      "telemetry",
      "nanomind-telemetry.js",
    );

    /** Stats HMA queues for one classified file under `env`. */
    async function queuedStats(env: NodeJS.ProcessEnv): Promise<string> {
      const { execFileSync } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const script =
        `const t = require(${JSON.stringify(telemetryModule)});` +
        `t.queueClassificationStat("skill", "x", "benign", 0.9, "test");` +
        `process.stdout.write(String(t.getTelemetryQueueSize()));`;
      return execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
    }

    it("queues no classification telemetry for a saved enabled of \"false\"", async () => {
      saveChoice(join(tempHome, ".opena2a"), "false");
      expect(await queuedStats(hmaEnv())).toBe("0");
    });

    it("queues classification telemetry for a saved enabled of true", async () => {
      saveChoice(join(tempHome, ".opena2a"), true);
      expect(await queuedStats(hmaEnv())).toBe("1");
    });

    // A `secure` run moves `"contribute": true` from ~/.hackmyagent/config.json
    // into ~/.opena2a/config.json unless HMA reads the saved choice as on.
    it.each(["false", "true"])(
      "a scan leaves a saved enabled of %j in place when ~/.hackmyagent/config.json holds \"contribute\": true",
      async (value) => {
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const { promisify } = await vi.importActual<typeof import("node:util")>("node:util");
        vi.mocked(execFile as any).mockImplementation(promisify(actual.execFile));
        saveChoice(join(tempHome, ".opena2a"), value);
        saveLegacyChoice(true);
        const pkg = join(tempHome, "pkg");
        mkdirSync(pkg);
        writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
        // Keep the scanner's anonymous usage telemetry off for this run.
        const savedTelemetry = process.env.OPENA2A_TELEMETRY;
        process.env.OPENA2A_TELEMETRY = "off";
        try {
          await runHmaScan(pkg, { deep: false });
        } finally {
          if (savedTelemetry === undefined) delete process.env.OPENA2A_TELEMETRY;
          else process.env.OPENA2A_TELEMETRY = savedTelemetry;
        }

        const read = (dir: string) => JSON.parse(readFileSync(join(tempHome, dir, "config.json"), "utf8"));
        expect(read(".opena2a").contribute.enabled).toBe(value);
        expect(read(".hackmyagent").contribute).toBe(true);
      },
      60000,
    );
  });
});
