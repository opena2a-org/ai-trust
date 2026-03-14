/**
 * Tests for output formatting functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCheckResult, formatBatchResults, formatJson } from "./formatter.js";
import type { TrustAnswer, BatchResponse } from "../api/client.js";

// Disable chalk colors for predictable test output
vi.mock("chalk", () => {
  const identity = (text: string) => text;
  const chalkMock: Record<string, unknown> = {
    green: identity,
    yellow: identity,
    red: identity,
    gray: identity,
    bold: identity,
  };
  return { default: chalkMock };
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
    expect(output).toContain("SAFE");
    expect(output).toContain("Verified");
    expect(output).toContain("0.95");
    expect(output).toContain("mcp_server");
    expect(output).toContain("complete");
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

    expect(output).toContain("Dependencies");
    expect(output).toContain("15");
    expect(output).toContain("2");
    expect(output).toContain("1/4");
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

    expect(output).not.toContain("Dependencies");
  });

  it("shows unknown for missing packageType", () => {
    const answer = makeTrustAnswer({ packageType: undefined, found: false });
    const output = formatCheckResult(answer);
    expect(output).toContain("unknown");
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

  it("reports not-found packages", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "missing-pkg", found: false }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("not found in registry");
    expect(output).toContain("missing-pkg");
  });

  it("shows all-clear message when everything passes", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "good-pkg", trustLevel: 4 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("All 1 packages meet minimum trust level 3");
  });

  it("truncates long package names", () => {
    const longName = "a".repeat(50);
    const response = makeBatchResponse([
      makeTrustAnswer({ name: longName }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("...");
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
