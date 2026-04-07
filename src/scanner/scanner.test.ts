/**
 * Tests for the scan orchestrator (scanPackage, trust derivation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./downloader.js", () => ({
  downloadPackage: vi.fn(),
}));

vi.mock("./hma.js", () => ({
  runHmaScan: vi.fn(),
  isHmaAvailable: vi.fn(),
}));

import { downloadPackage } from "./downloader.js";
import { runHmaScan } from "./hma.js";
import { scanPackage } from "./index.js";

describe("scanPackage", () => {
  const mockCleanup = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(downloadPackage).mockResolvedValue({
      dir: "/tmp/ai-trust-scan-123/package",
      cleanup: mockCleanup,
    });
  });

  it("downloads, scans, and cleans up", async () => {
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 95,
      maxScore: 100,
      findings: [],
      projectType: "mcp",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("test-pkg");

    expect(downloadPackage).toHaveBeenCalledWith("test-pkg", "npm");
    expect(runHmaScan).toHaveBeenCalledWith(
      "/tmp/ai-trust-scan-123/package",
      {}
    );
    expect(mockCleanup).toHaveBeenCalled();

    expect(result.packageName).toBe("test-pkg");
    expect(result.trustScore).toBeCloseTo(0.95);
    expect(result.trustLevel).toBe(3); // >= 0.9
    expect(result.verdict).toBe("safe");
  });

  it("derives warning verdict for high-severity findings", async () => {
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 75,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-001",
          name: "High issue",
          description: "",
          category: "secrets",
          severity: "high",
          passed: false,
          message: "Found issue",
        },
      ],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("risky-pkg");

    expect(result.verdict).toBe("warning");
  });

  it("derives blocked verdict for critical findings", async () => {
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 20,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-002",
          name: "Critical issue",
          description: "",
          category: "secrets",
          severity: "critical",
          passed: false,
          message: "Critical problem",
        },
      ],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("bad-pkg");

    expect(result.verdict).toBe("blocked");
    expect(result.trustLevel).toBe(0);
  });

  it("derives warning (not blocked) for high score with critical findings", async () => {
    // Regression: a filesystem MCP server scored 92/100 but got BLOCKED
    // because generic checks (SQL injection, password hashing) fired as
    // critical. Score should gate the verdict -- high score + criticals = warning.
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 92,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-010",
          name: "SQL Injection Protection",
          description: "",
          category: "security",
          severity: "critical",
          passed: false,
          message: "No parameterized queries found",
        },
        {
          checkId: "SEC-011",
          name: "Password Hashing",
          description: "",
          category: "security",
          severity: "critical",
          passed: false,
          message: "No bcrypt/argon2 found",
        },
      ],
      projectType: "mcp",
      timestamp: "2026-04-07T00:00:00Z",
    });

    const result = await scanPackage("@modelcontextprotocol/server-filesystem");

    expect(result.verdict).toBe("warning");
    expect(result.trustScore).toBeCloseTo(0.92);
    expect(result.trustLevel).toBe(3); // 92% -> Scanned tier
  });

  it("cleans up even when scan fails", async () => {
    vi.mocked(runHmaScan).mockRejectedValue(
      new Error("scan crashed")
    );

    await expect(scanPackage("crash-pkg")).rejects.toThrow(
      "scan crashed"
    );
    expect(mockCleanup).toHaveBeenCalled();
  });

  it("derives trust levels correctly", async () => {
    // Score 90% -> level 3
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 90,
      maxScore: 100,
      findings: [],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });
    let result = await scanPackage("pkg-a");
    expect(result.trustLevel).toBe(3);

    // Score 70% -> level 2
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 70,
      maxScore: 100,
      findings: [],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });
    result = await scanPackage("pkg-b");
    expect(result.trustLevel).toBe(2);

    // Score 40% -> level 1
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 40,
      maxScore: 100,
      findings: [],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });
    result = await scanPackage("pkg-c");
    expect(result.trustLevel).toBe(1);

    // Score 30% -> level 0
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 30,
      maxScore: 100,
      findings: [],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });
    result = await scanPackage("pkg-d");
    expect(result.trustLevel).toBe(0);
  });
});
