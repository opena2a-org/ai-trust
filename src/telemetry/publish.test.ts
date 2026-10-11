/**
 * Tests for the published scan submission: what leaves the machine when a
 * user contributes a scan.
 */

import { describe, it, expect } from "vitest";
import type { HmaFinding } from "../scanner/hma.js";
import type { ScanResult } from "../scanner/index.js";
import { buildScanSubmission, toPublishedFindings } from "./publish.js";

const finding: HmaFinding = {
  checkId: "CRED-001",
  name: "Hardcoded API key in src/config.ts",
  description: "API key sk-1234 found",
  category: "credentials",
  severity: "critical",
  passed: false,
  message: 'const KEY = "sk-1234"',
  file: "src/config.ts",
  line: 12,
  fix: "Remove the key",
  attackClass: "CRED-HARVEST",
};

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    packageName: "demo",
    scan: {
      score: 40,
      maxScore: 100,
      findings: [finding],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    },
    trustScore: 0.4,
    trustLevel: 1,
    verdict: "blocked",
    ...overrides,
  };
}

describe("toPublishedFindings", () => {
  it("keeps only check ID, severity, pass/fail, category and attack class", () => {
    expect(toPublishedFindings([finding])).toEqual([
      {
        checkId: "CRED-001",
        name: "CRED-001",
        severity: "critical",
        passed: false,
        message: "",
        category: "credentials",
        attackClass: "CRED-HARVEST",
      },
    ]);
  });
});

describe("buildScanSubmission", () => {
  it("never carries finding names, messages, descriptions, paths or fixes", () => {
    const wire = JSON.stringify(
      buildScanSubmission("demo", scanResult({ packageVersion: "1.0.0" }), { toolVersion: "0.0.0" }),
    );
    for (const leaked of ["Hardcoded API key", "sk-1234", "src/config.ts", "Remove the key"]) {
      expect(wire).not.toContain(leaked);
    }
  });

  it("sends the package version and maps the verdict", () => {
    const submission = buildScanSubmission(
      "demo",
      scanResult({ packageVersion: "1.0.0" }),
      { toolVersion: "0.0.0", type: "mcp_server" },
    );
    expect(submission).toMatchObject({
      name: "demo",
      version: "1.0.0",
      type: "mcp_server",
      score: 40,
      maxScore: 100,
      tool: "ai-trust",
      toolVersion: "0.0.0",
      verdict: "fail",
      projectType: "library",
    });
    expect(buildScanSubmission("demo", scanResult({ verdict: "warning" }), { toolVersion: "0.0.0" }).verdict).toBe("warn");
    expect(buildScanSubmission("demo", scanResult({ verdict: "safe" }), { toolVersion: "0.0.0" }).verdict).toBe("pass");
  });

  it("sends the ecosystem the package was downloaded from", () => {
    expect(
      buildScanSubmission("demo", scanResult(), { toolVersion: "0.0.0", ecosystem: "pypi" }).ecosystem,
    ).toBe("pypi");
    expect(
      buildScanSubmission("demo", scanResult(), { toolVersion: "0.0.0", ecosystem: "npm" }).ecosystem,
    ).toBe("npm");
  });

  it("omits version from the wire when the manifest carried none", () => {
    const wire = JSON.parse(
      JSON.stringify(buildScanSubmission("demo", scanResult(), { toolVersion: "0.0.0" })),
    ) as Record<string, unknown>;
    expect("version" in wire).toBe(false);
  });
});
