/**
 * Tests for the curated `ai-trust check --json` shape (issue #191).
 *
 * Every emitted field must trace to a real value the check pipeline produced.
 * Unavailable values are omitted, never fabricated.
 */

import { describe, it, expect } from "vitest";
import type { TrustAnswer } from "@opena2a/registry-client";
import type { ScanResult } from "../scanner/index.js";
import {
  buildCheckJson,
  buildCheckJsonFromAnswer,
  buildCheckJsonFromScan,
} from "./check-json.js";

describe("buildCheckJsonFromAnswer (registry path)", () => {
  it("maps a TrustAnswer onto the curated camelCase shape", () => {
    const answer: TrustAnswer = {
      name: "@modelcontextprotocol/server-filesystem",
      packageType: "mcp_server",
      trustLevel: 3,
      trustScore: 0.824,
      verdict: "passed",
      found: true,
    };
    const json = buildCheckJsonFromAnswer(answer);
    expect(json).toEqual({
      name: "@modelcontextprotocol/server-filesystem",
      source: "registry",
      found: true,
      packageType: "mcp_server",
      verdict: "passed",
      trustLevel: 3,
      trustScore: 0.824,
    });
  });

  it("omits score/maxScore/findings (registry lookup does not return them)", () => {
    const answer: TrustAnswer = {
      name: "some-mcp",
      trustLevel: 2,
      trustScore: 0.5,
      verdict: "warning",
      found: true,
    };
    const json = buildCheckJsonFromAnswer(answer);
    expect(json).not.toHaveProperty("score");
    expect(json).not.toHaveProperty("maxScore");
    expect(json).not.toHaveProperty("findings");
  });

  it("propagates found=false without inventing a verdict", () => {
    const answer = {
      name: "ghost",
      trustLevel: 0,
      trustScore: 0,
      verdict: "unknown",
      found: false,
    } as TrustAnswer;
    const json = buildCheckJsonFromAnswer(answer);
    expect(json.found).toBe(false);
    expect(json.source).toBe("registry");
  });
});

describe("buildCheckJsonFromScan (scan path)", () => {
  const baseScan: ScanResult = {
    packageName: "scanned-pkg",
    scan: {
      score: 45,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-001",
          name: "Hardcoded secret",
          description: "Found hardcoded API key",
          category: "secrets",
          severity: "high",
          passed: false,
          message: "API key found in source",
          attackClass: "credential-leak",
        },
        {
          checkId: "GIT-010",
          name: "Has .gitignore",
          description: "ok",
          category: "git",
          severity: "low",
          passed: true,
          message: "",
        },
      ],
      projectType: "mcp_server",
      timestamp: "2026-06-08T00:00:00Z",
    },
    trustScore: 0.45,
    trustLevel: 1,
    verdict: "warning",
  };

  it("maps a ScanResult onto the curated shape with real score/maxScore", () => {
    const json = buildCheckJsonFromScan(baseScan);
    expect(json.name).toBe("scanned-pkg");
    expect(json.source).toBe("scan");
    expect(json.found).toBe(true);
    expect(json.score).toBe(45);
    expect(json.maxScore).toBe(100);
    expect(json.verdict).toBe("warning");
    expect(json.trustLevel).toBe(1);
    expect(json.trustScore).toBe(0.45);
    expect(json.packageType).toBe("mcp_server");
  });

  it("includes only FAILED findings, mapped to camelCase", () => {
    const json = buildCheckJsonFromScan(baseScan);
    expect(json.findings).toHaveLength(1);
    expect(json.findings![0]).toEqual({
      checkId: "SEC-001",
      name: "Hardcoded secret",
      severity: "high",
      passed: false,
      message: "API key found in source",
      category: "secrets",
      attackClass: "credential-leak",
    });
  });

  it("omits the findings array entirely when there are no failures", () => {
    const clean: ScanResult = {
      ...baseScan,
      scan: { ...baseScan.scan, findings: [], score: 100 },
      verdict: "safe",
    };
    const json = buildCheckJsonFromScan(clean);
    expect(json).not.toHaveProperty("findings");
  });

  it("omits optional finding fields that are absent/empty", () => {
    const minimal: ScanResult = {
      ...baseScan,
      scan: {
        ...baseScan.scan,
        findings: [
          {
            checkId: "X-1",
            name: "bare",
            description: "",
            category: "",
            severity: "medium",
            passed: false,
            message: "",
          },
        ],
      },
    };
    const json = buildCheckJsonFromScan(minimal);
    const f = json.findings![0];
    expect(f).not.toHaveProperty("message");
    expect(f).not.toHaveProperty("attackClass");
    // category is "" -> still defined on the source, so it is preserved as ""
    expect(f.category).toBe("");
  });
});

describe("buildCheckJson (union)", () => {
  it("dispatches to the registry builder", () => {
    const json = buildCheckJson({
      kind: "registry",
      answer: {
        name: "r",
        trustLevel: 4,
        trustScore: 0.9,
        verdict: "safe",
        found: true,
      } as TrustAnswer,
    });
    expect(json.source).toBe("registry");
  });

  it("dispatches to the scan builder", () => {
    const json = buildCheckJson({
      kind: "scan",
      scan: {
        packageName: "s",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-06-08T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      },
    });
    expect(json.source).toBe("scan");
  });

  it("produces output that round-trips through JSON.parse", () => {
    const json = buildCheckJson({
      kind: "registry",
      answer: {
        name: "p",
        trustLevel: 3,
        trustScore: 0.7,
        verdict: "passed",
        found: true,
      } as TrustAnswer,
    });
    const serialized = JSON.stringify(json);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(json);
  });
});
