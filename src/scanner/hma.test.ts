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

// rmSync runs as itself unless a test makes it refuse a path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

import { execFile } from "node:child_process";
import {
  isHmaAvailable,
  nothingToScan,
  runHmaScan,
  scannerNodeVersionProblem,
  scannerTempDirProblem,
} from "./hma.js";

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

describe("scannerNodeVersionProblem", () => {
  // The rejection execFile gives for the scanner's --version run on Node.js
  // 20.18.3, where hackmyagent 0.33.2 require()s @opena2a/registry-client.
  const requireEsmFailure = Object.assign(
    new Error("Command failed: node /app/node_modules/hackmyagent/dist/cli.js --version"),
    {
      code: 1,
      stdout: "",
      stderr:
        "Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/@opena2a/registry-client/dist/index.js from /app/node_modules/hackmyagent/dist/registry/publish.js not supported.\n",
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names this Node.js version and the versions to run instead when the --version check fails with ERR_REQUIRE_ESM", async () => {
    vi.mocked(execFile as any).mockRejectedValue(requireEsmFailure);

    expect(await isHmaAvailable()).toBe(false);
    expect(scannerNodeVersionProblem("20.18.3")).toBe(
      "The hackmyagent version ai-trust pins loads an ES module with require(), which Node.js 20.18.3 does not do (ERR_REQUIRE_ESM). Run ai-trust on Node.js 20.19.0 or a later 20.x release, or on 22.12.0 or later.",
    );
  });

  it("names a Node.js 18, 21 or 22 release before 22.12.0, and a 20.x release before 20.19.0", async () => {
    vi.mocked(execFile as any).mockRejectedValue(requireEsmFailure);
    expect(await isHmaAvailable()).toBe(false);

    for (const version of ["18.20.8", "20.0.0", "20.18.3", "21.7.3", "22.0.0", "22.11.0"]) {
      expect(scannerNodeVersionProblem(version)).toContain(
        `which Node.js ${version} does not do (ERR_REQUIRE_ESM)`,
      );
    }
  });

  it("is null on Node.js 20.19.0 and later 20.x releases, and on 22.12.0 and later", async () => {
    vi.mocked(execFile as any).mockRejectedValue(requireEsmFailure);
    expect(await isHmaAvailable()).toBe(false);

    for (const version of ["20.19.0", "20.20.0", "22.12.0", "22.23.3", "23.0.0", "24.21.0", "26.12.0"]) {
      expect(scannerNodeVersionProblem(version)).toBeNull();
    }
  });

  it("is null when the --version check fails without ERR_REQUIRE_ESM", async () => {
    vi.mocked(execFile as any).mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "Error: Cannot find module './cli-impl.js'\n",
      }),
    );

    expect(await isHmaAvailable()).toBe(false);
    expect(scannerNodeVersionProblem("20.18.3")).toBeNull();
  });

  it("is null once a later --version check passes", async () => {
    vi.mocked(execFile as any).mockRejectedValueOnce(requireEsmFailure);
    expect(await isHmaAvailable()).toBe(false);
    vi.mocked(execFile as any).mockResolvedValueOnce({ stdout: "0.33.2\n", stderr: "" });
    expect(await isHmaAvailable()).toBe(true);

    expect(scannerNodeVersionProblem("20.18.3")).toBeNull();
  });

  // The message and the version cases above name the releases this range allows.
  it("matches the engines range in package.json", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(manifest.engines.node).toBe(">=20.19.0 <21 || >=22.12.0");
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

  describe("semantic count", () => {
    const record = (checkId: string, passed: boolean) => ({
      checkId,
      name: checkId,
      description: checkId,
      category: "credentials",
      severity: "high",
      passed,
      message: checkId,
    });
    const allFindings = [
      record("CRED-001", false),
      record("PERM-001", false),
      record("GIT-002", true),
      record("SEM-CRED-001", false),
      record("AST-CRED-001", false),
    ];
    // `semanticAnalysis` and `coverage.semanticFamilyCoverage` as
    // `hackmyagent secure --format json --deep` (0.33.2) printed them for
    // test/dvaa; the `partial` list keeps its first two of seven entries.
    const deepJson = JSON.stringify({
      score: 4,
      maxScore: 100,
      projectType: "api",
      findings: allFindings.filter((f) => !f.passed),
      allFindings,
      semanticAnalysis: { layer2Findings: 16, layer3Findings: 0 },
      coverage: {
        semanticCompileSetTruncated: false,
        semanticFamilyCoverage: {
          totalFamilies: 7,
          artifactsCompiled: 12,
          fullyExamined: 1,
          partial: [
            {
              artifactType: "unknown",
              route: "non_agent",
              familiesExamined: ["credentials", "stego"],
              artifacts: 3,
              examplePaths: ["attack-payloads.json", "challenge-config.json", "mcp-tools.json"],
            },
            {
              artifactType: "unknown",
              route: "not_routed",
              familiesExamined: [],
              artifacts: 2,
              examplePaths: ["README.md", "package.json"],
            },
          ],
        },
      },
    });

    it("reads the scanner's compile count, not its Layer 2 findings count", async () => {
      vi.mocked(execFile as any).mockResolvedValue({ stdout: deepJson, stderr: "" });

      const result = await runHmaScan("/tmp/test-pkg");

      expect(result.semanticCount).toBe(12);
      expect(result.staticOnly).toBeUndefined();
    });

    it("counts static checks without the AST-*/SEM-* records", async () => {
      vi.mocked(execFile as any).mockResolvedValue({ stdout: deepJson, stderr: "" });

      const result = await runHmaScan("/tmp/test-pkg");

      expect(result.checksEvaluated).toBe(5);
      expect(result.staticChecksEvaluated).toBe(3);
    });

    it("marks a --static-only scan as one where the semantic layer did not run", async () => {
      const staticJson = JSON.stringify({
        score: 13,
        maxScore: 100,
        findings: [],
        allFindings: allFindings.filter((f) => !f.checkId.startsWith("AST-")),
        semanticAnalysis: { layer2Findings: 16, layer3Findings: 0 },
        coverage: {
          semanticCompileSetTruncated: false,
          semanticFamilyCoverage: { totalFamilies: 7, artifactsCompiled: 0, fullyExamined: 0, partial: [] },
        },
      });
      vi.mocked(execFile as any).mockResolvedValue({ stdout: staticJson, stderr: "" });

      const result = await runHmaScan("/tmp/test-pkg", { deep: false });

      expect(result.staticOnly).toBe(true);
      expect(result.semanticCount).toBe(0);
      expect(result.staticChecksEvaluated).toBe(3);
    });

    it("does not mark the scan static-only when an older scanner rejected --static-only", async () => {
      vi.mocked(execFile as any).mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes("secure") && args.includes("--static-only")) {
          const error = new Error(
            "Command failed: hackmyagent secure\nerror: unknown option '--static-only'\n"
          );
          (error as any).stdout = "";
          throw error;
        }
        return { stdout: JSON.stringify({ score: 75, maxScore: 100, findings: [] }), stderr: "" };
      });

      const result = await runHmaScan("/tmp/test-pkg", { deep: false });

      expect(result.staticOnly).toBeUndefined();
    });

    it("leaves the semantic count unset when the scanner JSON carries no compile count", async () => {
      vi.mocked(execFile as any).mockResolvedValue({
        stdout: JSON.stringify({ score: 75, maxScore: 100, findings: [], allFindings }),
        stderr: "",
      });

      const result = await runHmaScan("/tmp/test-pkg");

      expect(result.semanticCount).toBeUndefined();
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

  describe("files the scanner read", () => {
    // From the `secure --format json --no-contribute --static-only` output of
    // hackmyagent 0.33.2 on an empty directory: its two failed findings, its
    // score and its `coverage` block, with `coverage.executions` cut to its
    // first two entries and the other top-level fields and per-category
    // lists left out.
    const emptyDirScan = {
      hackmyagentVersion: "0.33.2",
      projectType: "library",
      findings: [
        {
          checkId: "GIT-001",
          name: "Missing .gitignore",
          category: "git hygiene",
          severity: "low",
          passed: false,
          message: "Create .gitignore to protect sensitive files",
          file: ".gitignore",
        },
        {
          checkId: "DEP-001",
          name: "Dependency Lock File",
          category: "supply-chain",
          severity: "medium",
          passed: false,
          message: "No lock file found - dependency versions may vary between installs",
          file: "package-lock.json",
        },
      ],
      score: 93,
      maxScore: 100,
      coverage: {
        filesExamined: 0,
        executions: [
          { method: "checkCredentialExposure", prefixes: ["CRED"], completed: true, filesRead: 0, pathsInspected: 1 },
          { method: "checkClaudeMd", prefixes: ["CLAUDE"], completed: true, filesRead: 0, pathsInspected: 0 },
        ],
        truncations: [],
        filesReadByCategory: {},
        decode: {
          maxDepth: 3,
          artifactsRead: 0,
          artifactsWithPayloads: 0,
          payloads: 0,
          deepestDepth: 0,
          haltedAtBound: false,
        },
        unevidencedFailures: 0,
        unreadableInputs: { count: 0, codes: {}, directories: 0 },
        measured: true,
        examined: 0,
        total: 0,
        unit: "file",
      },
    };

    it("reads coverage.filesExamined as the number of files read", async () => {
      vi.mocked(execFile as any).mockResolvedValue({
        stdout: JSON.stringify(emptyDirScan),
        stderr: "",
      });

      const result = await runHmaScan("/tmp/empty");
      expect(result.filesExamined).toBe(0);
      expect(result.score).toBe(93);
    });

    it("carries a non-zero count as given", async () => {
      vi.mocked(execFile as any).mockResolvedValue({
        stdout: JSON.stringify({
          ...emptyDirScan,
          coverage: { ...emptyDirScan.coverage, filesExamined: 12 },
        }),
        stderr: "",
      });

      const result = await runHmaScan("/tmp/project");
      expect(result.filesExamined).toBe(12);
    });

    it("leaves it unset when the scanner reports no coverage or a count that is not a whole number", async () => {
      for (const coverage of [undefined, {}, { filesExamined: "0" }, { filesExamined: -1 }, { filesExamined: 1.5 }]) {
        vi.mocked(execFile as any).mockResolvedValue({
          stdout: JSON.stringify({ ...emptyDirScan, coverage }),
          stderr: "",
        });

        const result = await runHmaScan("/tmp/project");
        expect(result.filesExamined, JSON.stringify(coverage)).toBeUndefined();
      }
    });

    it("reads coverage.unreadableInputs.count as the number of inputs found but not read", async () => {
      // The same scanner's output for a directory that holds one file the
      // scanner could not read: 0 files read, one unreadable input.
      vi.mocked(execFile as any).mockResolvedValue({
        stdout: JSON.stringify({
          ...emptyDirScan,
          coverage: {
            ...emptyDirScan.coverage,
            unreadableInputs: { count: 1, codes: { EACCES: 1 }, directories: 0 },
          },
        }),
        stderr: "",
      });

      const result = await runHmaScan("/tmp/unreadable");
      expect(result.filesExamined).toBe(0);
      expect(result.unreadableInputs).toBe(1);
      expect(nothingToScan(result)).toBe(false);
    });

    it("reports nothing to scan for 0 files read and 0 unreadable inputs", async () => {
      vi.mocked(execFile as any).mockResolvedValue({
        stdout: JSON.stringify(emptyDirScan),
        stderr: "",
      });

      const result = await runHmaScan("/tmp/empty");
      expect(result.unreadableInputs).toBe(0);
      expect(nothingToScan(result)).toBe(true);
    });

    it("leaves the unreadable count unset when the scanner reports none or one that is not a whole number", async () => {
      for (const unreadableInputs of [undefined, {}, { count: "1" }, { count: -1 }, { count: 0.5 }]) {
        vi.mocked(execFile as any).mockResolvedValue({
          stdout: JSON.stringify({
            ...emptyDirScan,
            coverage: { ...emptyDirScan.coverage, unreadableInputs },
          }),
          stderr: "",
        });

        const result = await runHmaScan("/tmp/project");
        expect(result.unreadableInputs, JSON.stringify(unreadableInputs)).toBeUndefined();
        // With no unreadable count reported, 0 files read is nothing to scan.
        expect(nothingToScan(result), JSON.stringify(unreadableInputs)).toBe(true);
      }
    });
  });

  describe("nothingToScan", () => {
    it("is true only for 0 files read with no unreadable input", () => {
      expect(nothingToScan({ filesExamined: 0 })).toBe(true);
      expect(nothingToScan({ filesExamined: 0, unreadableInputs: 0 })).toBe(true);
      expect(nothingToScan({ filesExamined: 0, unreadableInputs: 1 })).toBe(false);
      expect(nothingToScan({ filesExamined: 3, unreadableInputs: 0 })).toBe(false);
      expect(nothingToScan({ filesExamined: 3, unreadableInputs: 2 })).toBe(false);
      expect(nothingToScan({})).toBe(false);
      expect(nothingToScan({ unreadableInputs: 0 })).toBe(false);
    });
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

// HMA's JSON report carries `coverageSweep` only when its analyst layer ran;
// without a daemon, `secure --analm` returns the same keys as a plain scan.
describe("runHmaScan analyst layer status (--analm)", () => {
  const base = { score: 100, maxScore: 100, findings: [], projectType: "library" };

  function answer(report: Record<string, unknown>): void {
    vi.mocked(execFile as any).mockResolvedValue({ stdout: JSON.stringify(report), stderr: "" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not set when the scan did not ask for the analyst", async () => {
    answer({ ...base, coverageSweep: { swept: 2, nullVerdicts: 0 } });

    const result = await runHmaScan("/tmp/test-pkg");

    expect(result.analystLayer).toBeUndefined();
  });

  it("reports no analyst output when the report has no coverage sweep and no analyst findings", async () => {
    answer(base);

    const result = await runHmaScan("/tmp/test-pkg", { analm: true });

    expect(result.analystLayer).toEqual({ ran: false, reason: "no-analyst-output" });
  });

  it("reports that it ran, with the sweep counts, when the report has a coverage sweep", async () => {
    answer({
      ...base,
      coverageSweep: { candidates: 2, swept: 2, skipped: 0, nullVerdicts: 1, policy: "abstention-gated" },
    });

    const result = await runHmaScan("/tmp/test-pkg", { analm: true });

    expect(result.analystLayer).toEqual({
      ran: true,
      findingsAnalyzed: 0,
      sweep: { swept: 2, nullVerdicts: 1 },
    });
  });

  it("reports that it ran when the report has analyst findings and no coverage sweep", async () => {
    answer({
      ...base,
      analystFindings: [
        { taskType: "threatAnalysis", result: {}, confidence: 0.9, modelVersion: "3.0.0", durationMs: 10, backend: "daemon" },
      ],
    });

    const result = await runHmaScan("/tmp/test-pkg", { analm: true });

    expect(result.analystLayer).toEqual({ ran: true, findingsAnalyzed: 1 });
  });

  it("reports static-only when the scan ran with --static-only", async () => {
    answer(base);

    const result = await runHmaScan("/tmp/test-pkg", { analm: true, deep: false });

    expect(result.analystLayer).toEqual({ ran: false, reason: "static-only" });
  });

  it("reports flag-rejected when the scanner refused --analm and the scan ran without it", async () => {
    vi.mocked(execFile as any).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("--analm")) {
        const stderr = "error: unknown option '--analm'";
        throw Object.assign(
          new Error(`Command failed: hackmyagent ${args.join(" ")}\n${stderr}`),
          { stdout: "", stderr },
        );
      }
      return { stdout: JSON.stringify(base), stderr: "" };
    });

    const result = await runHmaScan("/tmp/test-pkg", { analm: true });

    expect(result.analystLayer).toEqual({ ran: false, reason: "flag-rejected" });
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

  it("names a TMPDIR where the temporary home can be created but not removed, and does not throw; the scan fails with the same reason", async () => {
    const createOnly = join(scratch, "create-only");
    mkdirSync(createOnly);
    process.env.TMPDIR = createOnly;
    const probe = join(createOnly, "ai-trust-scanner-");
    const refused = Object.assign(new Error(`EACCES, Permission denied: ${probe}`), { code: "EACCES" });
    const { rmSync: realRmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    // Removing an entry of TMPDIR itself is refused; removing what is inside one is not.
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (dirname(String(path)) === createOnly) throw refused;
      return realRmSync(path, options);
    });

    try {
      expect(scannerTempDirProblem()).toBe(
        `ai-trust runs the scanner with a new temporary home directory and could not remove the one it created in ${createOnly} (EACCES). Point TMPDIR at a directory where you can both create and remove entries, for example: export TMPDIR=/tmp`,
      );
      expect(rmSync).toHaveBeenCalledWith(expect.stringContaining(probe), expect.anything());
      // The probe directory stays, since removing it was refused.
      expect(readdirSync(createOnly)).toHaveLength(1);
      // The scanner's --version check runs, and its temporary home is not removed.
      expect(await isHmaAvailable()).toBe(false);
      expect(execFile).toHaveBeenCalledTimes(1);
      await expect(runHmaScan("/tmp/test-pkg")).rejects.toThrow(
        `could not remove the one it created in ${createOnly} (EACCES). Point TMPDIR at`,
      );
    } finally {
      vi.mocked(rmSync).mockImplementation(realRmSync);
    }
  });
});
