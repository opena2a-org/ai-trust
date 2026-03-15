/**
 * Tests for HMA subprocess runner.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { isHmaAvailable, runHmaScan } from "./hma.js";

describe("isHmaAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when npx hackmyagent --version succeeds", async () => {
    vi.mocked(execFile as any).mockResolvedValue({
      stdout: "0.10.2",
      stderr: "",
    });

    const result = await isHmaAvailable();
    expect(result).toBe(true);
  });

  it("returns false when npx hackmyagent fails", async () => {
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
