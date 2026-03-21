/**
 * Tests for community contribution module.
 *
 * Verifies:
 *   - Legacy payload structure matches server-side schema (backward compat)
 *   - No PII (file paths, line numbers, descriptions, fix text) in payload
 *   - Contributor token is a 64-char hex SHA256
 *   - queueScanResult delegates to @opena2a/contribute with correct summary
 *   - flushQueue delegates to @opena2a/contribute
 *   - Queue-based submission handles errors gracefully
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock @opena2a/contribute before importing the module under test
vi.mock("@opena2a/contribute", () => {
  const scanResultMock = vi.fn().mockResolvedValue(undefined);
  const flushMock = vi.fn().mockResolvedValue(true);
  const queueEventMock = vi.fn();
  return {
    contribute: {
      scanResult: scanResultMock,
      flush: flushMock,
    },
    getContributorToken: vi.fn().mockReturnValue(
      "a".repeat(64) // 64-char hex string
    ),
    queueEvent: queueEventMock,
  };
});

import {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  queueScanResult,
  flushQueue,
  type ContributionPayload,
} from "./contribute.js";
import type { HmaFinding } from "../scanner/hma.js";
import {
  contribute,
  getContributorToken,
  queueEvent,
} from "@opena2a/contribute";

/**
 * Sample findings with full detail (file paths, line numbers, descriptions, fix text).
 * The contribution module must strip all of this.
 */
function makeSampleFindings(): HmaFinding[] {
  return [
    {
      checkId: "CRED-001",
      name: "Hardcoded API key",
      description: "Found hardcoded API key in src/config.ts",
      category: "credentials",
      severity: "critical",
      passed: false,
      message: "API key sk-1234 found in source code",
      file: "src/config.ts",
      line: 42,
      fix: "Remove the key and use environment variables",
      attackClass: "credential-exposure",
    },
    {
      checkId: "MCP-003",
      name: "MCP server config",
      description: "MCP server config is world-readable",
      category: "mcp",
      severity: "high",
      passed: false,
      message: "File permissions are 0644",
      file: ".mcp/config.json",
      line: 1,
      fix: "chmod 600 .mcp/config.json",
    },
    {
      checkId: "GIT-001",
      name: "Gitignore coverage",
      description: ".gitignore covers secrets",
      category: "git",
      severity: "low",
      passed: true,
      message: "OK",
    },
  ];
}

describe("buildContributionPayload (legacy)", () => {
  it("strips sensitive fields from findings", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());

    for (const f of payload.findings) {
      // Only these fields should exist
      expect(Object.keys(f).sort()).toEqual(
        ["checkId", "result", "severity"].sort()
      );

      // Must NOT contain sensitive data
      expect(f).not.toHaveProperty("name");
      expect(f).not.toHaveProperty("description");
      expect(f).not.toHaveProperty("message");
      expect(f).not.toHaveProperty("file");
      expect(f).not.toHaveProperty("line");
      expect(f).not.toHaveProperty("fix");
      expect(f).not.toHaveProperty("attackClass");
      expect(f).not.toHaveProperty("category");
    }
  });

  it("maps passed=false to result=fail and passed=true to result=pass", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());

    expect(payload.findings[0].result).toBe("fail"); // CRED-001 failed
    expect(payload.findings[1].result).toBe("fail"); // MCP-003 failed
    expect(payload.findings[2].result).toBe("pass"); // GIT-001 passed
  });

  it("includes required top-level fields", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());

    expect(payload.contributorToken).toBeTruthy();
    expect(payload.contributorToken.length).toBe(64); // SHA256 hex
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.ecosystem).toBe("npm");
    expect(payload.scanTimestamp).toBeTruthy();
    expect(payload.aiTrustVersion).toBeTruthy();
    expect(["linux", "macos", "windows"]).toContain(payload.osType);
  });

  it("preserves severity values", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());

    expect(payload.findings[0].severity).toBe("critical");
    expect(payload.findings[1].severity).toBe("high");
    expect(payload.findings[2].severity).toBe("low");
  });

  it("handles empty findings array", () => {
    const payload = buildContributionPayload("test-pkg", []);
    expect(payload.findings).toEqual([]);
    expect(payload.packageName).toBe("test-pkg");
  });
});

describe("queueScanResult", () => {
  beforeEach(() => {
    vi.mocked(contribute.scanResult).mockClear();
  });

  it("delegates to contribute.scanResult with correct summary", () => {
    queueScanResult("test-pkg", makeSampleFindings());

    expect(contribute.scanResult).toHaveBeenCalledOnce();
    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];

    expect(args.tool).toBe("ai-trust");
    expect(args.toolVersion).toBeTruthy();
    expect(args.packageName).toBe("test-pkg");
    expect(args.ecosystem).toBe("npm");
    expect(args.totalChecks).toBe(3);
    expect(args.passed).toBe(1);
    expect(args.critical).toBe(1);
    expect(args.high).toBe(1);
    expect(args.medium).toBe(0);
    expect(args.low).toBe(0);
  });

  it("does not include file paths or descriptions in the call", () => {
    queueScanResult("test-pkg", makeSampleFindings());

    const serialized = JSON.stringify(
      vi.mocked(contribute.scanResult).mock.calls[0][0]
    );
    expect(serialized).not.toContain("src/config.ts");
    expect(serialized).not.toContain(".mcp/config.json");
    expect(serialized).not.toContain("Found hardcoded API key");
    expect(serialized).not.toContain("API key sk-1234");
    expect(serialized).not.toContain("Remove the key");
    expect(serialized).not.toContain("chmod 600");
  });

  it("calls scanResult for each invocation", () => {
    queueScanResult("pkg-a", makeSampleFindings());
    queueScanResult("pkg-b", []);

    expect(contribute.scanResult).toHaveBeenCalledTimes(2);
    expect(vi.mocked(contribute.scanResult).mock.calls[0][0].packageName).toBe(
      "pkg-a"
    );
    expect(vi.mocked(contribute.scanResult).mock.calls[1][0].packageName).toBe(
      "pkg-b"
    );
  });

  it("computes score as percentage of passed checks", () => {
    queueScanResult("test-pkg", makeSampleFindings()); // 1/3 passed

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args.score).toBe(33); // Math.round(1/3 * 100)
  });

  it("handles empty findings with score 0", () => {
    queueScanResult("empty-pkg", []);

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args.score).toBe(0);
    expect(args.totalChecks).toBe(0);
  });
});

describe("generateContributorToken", () => {
  it("returns a 64-char hex string (SHA256)", () => {
    const token = generateContributorToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls (delegates to shared library)", () => {
    const token1 = generateContributorToken();
    const token2 = generateContributorToken();
    expect(token1).toBe(token2);
  });

  it("delegates to getContributorToken from @opena2a/contribute", () => {
    generateContributorToken();
    expect(getContributorToken).toHaveBeenCalled();
  });
});

describe("submitContribution (legacy)", () => {
  beforeEach(() => {
    vi.mocked(contribute.flush).mockClear();
    vi.mocked(queueEvent).mockClear();
  });

  it("queues event via shared library and flushes", async () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    const result = await submitContribution(payload, "http://localhost:1");

    expect(queueEvent).toHaveBeenCalledOnce();
    expect(contribute.flush).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it("returns failure when flush fails", async () => {
    vi.mocked(contribute.flush).mockResolvedValueOnce(false);

    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    const result = await submitContribution(payload, "http://localhost:1");

    expect(result.success).toBe(false);
  });
});

describe("flushQueue", () => {
  beforeEach(() => {
    vi.mocked(contribute.flush).mockClear();
  });

  it("returns true when delegate returns true", async () => {
    vi.mocked(contribute.flush).mockResolvedValueOnce(true);
    const result = await flushQueue("http://localhost:1");
    expect(result).toBe(true);
    expect(contribute.flush).toHaveBeenCalledWith("http://localhost:1", undefined);
  });

  it("returns false when delegate returns false", async () => {
    vi.mocked(contribute.flush).mockResolvedValueOnce(false);
    const result = await flushQueue("http://localhost:1");
    expect(result).toBe(false);
  });

  it("passes verbose flag to delegate", async () => {
    vi.mocked(contribute.flush).mockResolvedValueOnce(true);
    await flushQueue("http://localhost:1", true);
    expect(contribute.flush).toHaveBeenCalledWith("http://localhost:1", true);
  });
});

describe("payload privacy verification (legacy)", () => {
  it("does not contain any file path strings", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("src/config.ts");
    expect(serialized).not.toContain(".mcp/config.json");
  });

  it("does not contain fix instructions", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("Remove the key");
    expect(serialized).not.toContain("chmod 600");
  });

  it("does not contain descriptions or messages", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("Found hardcoded API key");
    expect(serialized).not.toContain("API key sk-1234");
    expect(serialized).not.toContain("world-readable");
  });

  it("does not contain line numbers", () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());

    // Line 42 from the CRED-001 finding should not appear
    for (const f of payload.findings) {
      expect(f).not.toHaveProperty("line");
    }
  });
});
