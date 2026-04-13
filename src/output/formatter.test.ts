/**
 * Tests for output formatting functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCheckResult, formatBatchResults, formatScanResult, formatJson } from "./formatter.js";
import type { TrustAnswer, BatchResponse } from "../api/client.js";
import type { ScanResult } from "../scanner/index.js";

// Disable chalk colors for predictable test output.
// Uses a Proxy so any chained access (chalk.bold.white, chalk.red.bold, etc.) works.
vi.mock("chalk", () => {
  const identity = (text: string) => String(text);
  const handler: ProxyHandler<typeof identity> = {
    get: () => new Proxy(identity, handler),
    apply: (_target, _thisArg, args) => String(args[0] ?? ""),
  };
  return { default: new Proxy(identity, handler) };
});

function makeTrustAnswer(overrides: Partial<TrustAnswer> = {}): TrustAnswer {
  return {
    name: "test-package",
    trustLevel: 3,
    trustScore: 0.85,
    verdict: "safe",
    found: true,
    packageType: "mcp_server",
    scanStatus: "complete",
    ...overrides,
  };
}

describe("formatCheckResult", () => {
  it("shows not-found message when package is not in registry", () => {
    const answer = makeTrustAnswer({ found: false, name: "unknown-pkg" });
    const output = formatCheckResult(answer);

    expect(output).toContain("unknown-pkg");
    expect(output).toContain("Not found in registry");
  });

  it("displays trust details for a found package", () => {
    const answer = makeTrustAnswer({
      name: "my-mcp-server",
      trustLevel: 4,
      trustScore: 0.95,
      verdict: "safe",
      packageType: "mcp_server",
      scanStatus: "complete",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("my-mcp-server");
    expect(output).toContain("No known issues");
    expect(output).toContain("Verified");
    expect(output).toContain("95/100");
    expect(output).toContain("mcp_server");
    // Verified packages should not show the trust level legend
    expect(output).not.toContain("Blocked > Warning");
  });

  it("shows trust level legend for non-Verified packages", () => {
    const answer = makeTrustAnswer({
      name: "listed-pkg",
      trustLevel: 2,
      verdict: "safe",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("Blocked");
    expect(output).toContain("Warning");
    expect(output).toContain("Listed");
    expect(output).toContain("Scanned");
    expect(output).toContain("Verified");
  });

  it("shows next steps after check result", () => {
    const answer = makeTrustAnswer({
      name: "some-pkg",
      trustLevel: 3,
      verdict: "safe",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("Next Steps");
    expect(output).toContain("ai-trust audit package.json");
  });

  it("shows scan suggestion for warning verdict", () => {
    const answer = makeTrustAnswer({
      name: "risky-pkg",
      trustLevel: 1,
      verdict: "warning",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("ai-trust check risky-pkg");
  });

  it("shows scan suggestion for listed trust level", () => {
    const answer = makeTrustAnswer({
      name: "listed-pkg",
      trustLevel: 2,
      verdict: "safe",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("Scan locally");
    expect(output).toContain("ai-trust check listed-pkg");
  });

  it("shows trust level labels correctly for each level", () => {
    const levels = [
      { level: 0, label: "Blocked" },
      { level: 1, label: "Warning" },
      { level: 2, label: "Listed" },
      { level: 3, label: "Scanned" },
      { level: 4, label: "Verified" },
    ];

    for (const { level, label } of levels) {
      const answer = makeTrustAnswer({ trustLevel: level });
      const output = formatCheckResult(answer);
      expect(output).toContain(label);
    }
  });

  it("handles unknown trust level", () => {
    const answer = makeTrustAnswer({ trustLevel: 99 });
    const output = formatCheckResult(answer);
    expect(output).toContain("Unknown (99)");
  });

  it("shows dependency info when available", () => {
    const answer = makeTrustAnswer({
      dependencies: {
        totalDeps: 15,
        vulnerableDeps: 2,
        minTrustLevel: 1,
        minTrustScore: 0.3,
        maxDepth: 3,
      },
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("Deps");
    expect(output).toContain("15 total");
    expect(output).toContain("2 vulnerable");
    expect(output).toContain("min trust 1/4");
  });

  it("omits dependency section when totalDeps is 0", () => {
    const answer = makeTrustAnswer({
      dependencies: {
        totalDeps: 0,
        vulnerableDeps: 0,
        minTrustLevel: 0,
        minTrustScore: 0,
        maxDepth: 0,
      },
    });
    const output = formatCheckResult(answer);

    expect(output).not.toContain("Deps");
  });

  it("shows unknown for missing packageType", () => {
    const answer = makeTrustAnswer({ packageType: undefined, found: false });
    const output = formatCheckResult(answer);
    expect(output).toContain("unknown");
  });

  it("shows 'Not scanned' instead of '0/100' for unscanned packages", () => {
    const answer = makeTrustAnswer({
      name: "express",
      trustScore: 0,
      scanStatus: "",
      trustLevel: 2,
      verdict: "listed",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("not scanned");
    expect(output).not.toContain("0/100");
  });

  it("shows 0/100 when score is 0 but scanStatus indicates a scan happened", () => {
    const answer = makeTrustAnswer({
      trustScore: 0,
      scanStatus: "complete",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("0/100");
    expect(output).not.toContain("Not scanned");
  });

  it("normalizes 'passed' verdict from registry to 'SAFE'", () => {
    const answer = makeTrustAnswer({
      verdict: "passed",
      scanStatus: "complete",
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("No known issues");
  });

  it("normalizes 'listed' verdict from registry", () => {
    const answer = makeTrustAnswer({
      verdict: "listed",
      trustScore: 0,
      scanStatus: "",
      trustLevel: 2,
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("Not yet security-scanned");
  });

  it("does not display confidence in check output", () => {
    const answer = makeTrustAnswer({
      confidence: 0.2,
    });
    const output = formatCheckResult(answer);

    expect(output).not.toContain("confidence");
  });

  it("shows scan age when lastScannedAt is present", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const answer = makeTrustAnswer({
      lastScannedAt: twoDaysAgo,
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("scanned 2 days ago");
  });

  it("shows stale warning for old scans", () => {
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const answer = makeTrustAnswer({
      lastScannedAt: oldDate,
    });
    const output = formatCheckResult(answer);

    expect(output).toContain("stale");
  });
});

describe("formatBatchResults", () => {
  function makeBatchResponse(
    results: TrustAnswer[],
    metaOverrides: Partial<BatchResponse["meta"]> = {}
  ): BatchResponse {
    const found = results.filter((r) => r.found).length;
    return {
      results,
      meta: {
        total: results.length,
        found,
        notFound: results.length - found,
        ...metaOverrides,
      },
    };
  }

  it("renders table header and summary line", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "pkg-a" }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Trust Audit");
    expect(output).toContain("PACKAGE");
    expect(output).toContain("VERDICT");
    expect(output).toContain("TRUST");
    expect(output).toContain("SCORE");
  });

  it("reports packages below minimum trust threshold", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "risky-pkg", trustLevel: 1, verdict: "warning" }),
      makeTrustAnswer({ name: "safe-pkg", trustLevel: 4, verdict: "safe" }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("1 package(s) below minimum trust level 3");
    expect(output).toContain("risky-pkg");
  });

  it("reports not-found packages with NO DATA and scan guidance", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "missing-pkg", found: false }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("not found in registry");
    expect(output).toContain("missing-pkg");
    expect(output).toContain("NO DATA");
    expect(output).toContain("--scan-missing");
    expect(output).toContain("ai-trust check <name>");
  });

  it("shows all-clear message when everything passes", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "good-pkg", trustLevel: 4 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("All 1 packages meet minimum trust level 3");
  });

  it("shows next steps after batch results", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "pkg-a", trustLevel: 3 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Next Steps");
    expect(output).toContain("npx hackmyagent secure");
  });

  it("shows check suggestion when packages are below threshold", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "risky-pkg", trustLevel: 1, verdict: "warning" }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("ai-trust check <name>");
  });

  it("shows trust level legend when non-Verified packages exist", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "listed-pkg", trustLevel: 2 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Blocked");
    expect(output).toContain("Verified");
  });

  it("does not show trust level legend when all packages are Verified", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "good-pkg", trustLevel: 4 }),
    ]);
    const output = formatBatchResults(response, 3);

    // Legend not shown when all packages are Verified
    expect(output).not.toContain("Blocked > Warning");
  });

  it("truncates long package names", () => {
    const longName = "a".repeat(50);
    const response = makeBatchResponse([
      makeTrustAnswer({ name: longName }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("...");
  });

  it("shows dimmed meter for unscanned packages (not a numeric score)", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "chalk",
        trustScore: 0,
        scanStatus: "",
        trustLevel: 2,
        verdict: "listed",
      }),
    ]);
    const output = formatBatchResults(response, 2);

    expect(output).toContain("--");
    expect(output).not.toMatch(/\b0\/100\b/);
  });

  it("shows 'Error' not numeric score when scanStatus is error", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "onnxruntime-node",
        trustScore: 0.27,
        scanStatus: "error",
        trustLevel: 2,
        verdict: "warning",
      }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Error");
    expect(output).not.toContain("27/100");
    expect(output).toContain("rescan for accurate score");
  });

  it("handles case-insensitive scanStatus for error display", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "bad-pkg",
        trustScore: 0.5,
        scanStatus: "Error",
        trustLevel: 1,
        verdict: "warning",
      }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Error");
    expect(output).not.toContain("50/100");
  });

  it("normalizes registry verdict 'passed' to 'SAFE' in table", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "mcp-pkg",
        verdict: "passed",
        scanStatus: "complete",
      }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("SAFE");
  });
});

describe("formatScanResult", () => {
  function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
      packageName: "test-pkg",
      trustScore: 0.85,
      trustLevel: 3,
      verdict: "safe",
      scan: {
        score: 85,
        maxScore: 100,
        findings: [],
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
      ...overrides,
    };
  }

  it("shows attack class when present on a finding", () => {
    const result = makeScanResult({
      scan: {
        score: 60,
        maxScore: 100,
        findings: [
          {
            checkId: "CRED-001",
            name: "Hardcoded Credentials",
            description: "Found hardcoded credentials",
            category: "secrets",
            severity: "critical",
            passed: false,
            message: "API key found in source code",
            attackClass: "CRED-HARVEST",
          },
        ],
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const output = formatScanResult(result);
    expect(output).toContain("CRED-HARVEST");
    expect(output).toContain("Attack:");
  });

  it("does not show attack class line when attackClass is absent", () => {
    const result = makeScanResult({
      scan: {
        score: 60,
        maxScore: 100,
        findings: [
          {
            checkId: "SEC-001",
            name: "Missing CSP",
            description: "No CSP header",
            category: "headers",
            severity: "medium",
            passed: false,
            message: "Content-Security-Policy header missing",
          },
        ],
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const output = formatScanResult(result);
    expect(output).not.toContain("Attack:");
  });
});

describe("formatJson", () => {
  it("returns pretty-printed JSON", () => {
    const data = { name: "test", trustLevel: 3 };
    const output = formatJson(data);

    expect(JSON.parse(output)).toEqual(data);
    expect(output).toContain("\n"); // pretty-printed
  });

  it("handles arrays", () => {
    const data = [1, 2, 3];
    const output = formatJson(data);
    expect(JSON.parse(output)).toEqual(data);
  });

  it("handles null", () => {
    expect(formatJson(null)).toBe("null");
  });
});
