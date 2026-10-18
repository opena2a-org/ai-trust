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

  it("carries the registry's finding counts, known CVEs, scan status and scan date (#105)", () => {
    const answer = {
      name: "@modelcontextprotocol/server-filesystem",
      packageType: "mcp_server",
      trustLevel: 3,
      trustScore: 0.7866666666666666,
      verdict: "passed",
      scanStatus: "warnings",
      lastScannedAt: "2026-03-02T00:46:00.496394Z",
      found: true,
      securityProfile: {
        id: "profile-id",
        criticalCount: 0,
        highCount: 1,
        knownCves: [],
        hasDrift: false,
      },
    } as TrustAnswer;
    const json = buildCheckJsonFromAnswer(answer);
    expect(json).toEqual({
      name: "@modelcontextprotocol/server-filesystem",
      source: "registry",
      found: true,
      packageType: "mcp_server",
      verdict: "passed",
      trustLevel: 3,
      trustScore: 0.7866666666666666,
      scanStatus: "warnings",
      lastScannedAt: "2026-03-02T00:46:00.496394Z",
      securityProfile: { criticalCount: 0, highCount: 1, knownCves: [] },
    });
  });

  it("normalizes known CVE entries to identifiers", () => {
    const answer = {
      name: "some-mcp",
      trustLevel: 2,
      trustScore: 0.5,
      verdict: "passed",
      found: true,
      securityProfile: {
        criticalCount: 1,
        highCount: 0,
        knownCves: ["CVE-2025-0001", { cveId: "CVE-2025-0002" }, 42, ""],
      },
    } as TrustAnswer;
    expect(buildCheckJsonFromAnswer(answer).securityProfile).toEqual({
      criticalCount: 1,
      highCount: 0,
      knownCves: ["CVE-2025-0001", "CVE-2025-0002"],
    });
  });

  it("omits securityProfile when the registry returned none or nothing readable in it", () => {
    const base = {
      name: "some-mcp",
      trustLevel: 2,
      trustScore: 0.5,
      verdict: "passed",
      found: true,
    };
    expect(buildCheckJsonFromAnswer(base as TrustAnswer)).not.toHaveProperty(
      "securityProfile",
    );
    const unreadable = {
      ...base,
      securityProfile: { criticalCount: null, highCount: -1, knownCves: [] },
    } as unknown as TrustAnswer;
    expect(buildCheckJsonFromAnswer(unreadable)).not.toHaveProperty("securityProfile");
  });

  it("keeps the readable fields of a profile whose other count is missing or invalid (#129)", () => {
    const base = {
      name: "some-mcp",
      trustLevel: 2,
      trustScore: 0.5,
      verdict: "passed",
      found: true,
    };
    const missing = {
      ...base,
      securityProfile: { highCount: 1, knownCves: [] },
    } as TrustAnswer;
    expect(buildCheckJsonFromAnswer(missing).securityProfile).toEqual({
      highCount: 1,
      knownCves: [],
    });
    const invalid = {
      ...base,
      securityProfile: { criticalCount: null, highCount: 2 },
    } as unknown as TrustAnswer;
    expect(buildCheckJsonFromAnswer(invalid).securityProfile).toEqual({
      highCount: 2,
      knownCves: [],
    });
  });

  it("leaves control characters in registry strings to JSON escaping (#129)", () => {
    const answer = {
      name: "some-mcp",
      trustLevel: 2,
      trustScore: 0.5,
      verdict: "passed",
      found: true,
      securityProfile: {
        criticalCount: 0,
        highCount: 0,
        knownCves: ["CVE-\u001b]0;x\u0007-1"],
      },
    } as TrustAnswer;
    const result = buildCheckJsonFromAnswer(answer);
    expect(result.securityProfile?.knownCves).toEqual(["CVE-\u001b]0;x\u0007-1"]);
    expect(JSON.stringify(result)).not.toMatch(/[\u0000-\u001f]/);
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
    expect(f).not.toHaveProperty("file");
    expect(f).not.toHaveProperty("line");
    expect(f).not.toHaveProperty("fix");
  });

  function withFinding(finding: Partial<ScanResult["scan"]["findings"][number]>): ScanResult {
    return {
      ...baseScan,
      scan: {
        ...baseScan.scan,
        findings: [
          {
            checkId: "CLAUDE-002",
            name: "Overly Permissive Permissions",
            description: "",
            category: "claude-code",
            severity: "high",
            passed: false,
            message: "Scope permissions to specific paths",
            ...finding,
          },
        ],
      },
    };
  }

  it("carries the scanner's file, line and fix on each finding", () => {
    const json = buildCheckJsonFromScan(
      withFinding({
        file: ".claude/settings.json",
        line: 4,
        fix: "Replace Bash(*) with the specific commands the agent needs",
      }),
    );
    expect(json.findings![0]).toMatchObject({
      checkId: "CLAUDE-002",
      file: ".claude/settings.json",
      line: 4,
      fix: "Replace Bash(*) with the specific commands the agent needs",
    });
  });

  it("emits the file and omits the line when the scanner supplied no line", () => {
    const json = buildCheckJsonFromScan(withFinding({ file: ".claude/settings.json" }));
    const f = json.findings![0];
    expect(f.file).toBe(".claude/settings.json");
    expect(f).not.toHaveProperty("line");
  });

  it("omits a line the scanner sent as null", () => {
    const json = buildCheckJsonFromScan(
      withFinding({ file: ".claude/settings.json", line: null as unknown as number }),
    );
    const f = json.findings![0];
    expect(f.file).toBe(".claude/settings.json");
    expect(f).not.toHaveProperty("line");
  });

  it("records the number of files the scanner read", () => {
    const json = buildCheckJsonFromScan({
      ...baseScan,
      scan: { ...baseScan.scan, filesExamined: 12 },
    });
    expect(json.filesExamined).toBe(12);
    expect(json.score).toBe(45);
    expect(json).not.toHaveProperty("scored");
  });

  it("omits filesExamined when the scanner did not report it", () => {
    expect(buildCheckJsonFromScan(baseScan)).not.toHaveProperty("filesExamined");
  });

  it("marks a scan that read 0 files as not scored, with no score, verdict, level, type or findings", () => {
    const json = buildCheckJsonFromScan({
      ...baseScan,
      scan: { ...baseScan.scan, filesExamined: 0, score: 93, projectType: "library" },
      trustScore: 0.93,
      trustLevel: 3,
      verdict: "safe",
    });
    expect(json).toEqual({
      name: "scanned-pkg",
      source: "scan",
      found: true,
      scored: false,
      notScoredReason: "nothing to scan: the scanner read 0 files",
      filesExamined: 0,
    });
  });

  it("keeps the score, verdict and findings of a scan that read 0 files because they could not be read", () => {
    // A directory holding one `.env` the scanner cannot read: 0 files read,
    // one unreadable input, and a finding that names the file.
    const json = buildCheckJsonFromScan({
      ...baseScan,
      scan: {
        ...baseScan.scan,
        filesExamined: 0,
        unreadableInputs: 1,
        score: 69,
        findings: [
          {
            checkId: "SCAN-UNREAD-001",
            name: "Input Discovered But Not Read",
            description: "",
            category: "coverage",
            severity: "medium",
            passed: false,
            message: ".env could not be read (EACCES)",
            file: ".env",
            fix: "chmod u+r .env",
          },
        ],
      },
      trustScore: 0.69,
      trustLevel: 2,
      verdict: "warning",
    });
    expect(json).not.toHaveProperty("scored");
    expect(json).not.toHaveProperty("notScoredReason");
    expect(json.score).toBe(69);
    expect(json.verdict).toBe("warning");
    expect(json.filesExamined).toBe(0);
    expect(json.findings?.map((f) => f.checkId)).toEqual(["SCAN-UNREAD-001"]);
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

describe("ecosystem (#131)", () => {
  const answer = {
    name: "requests",
    packageType: "library",
    trustLevel: 2,
    trustScore: 0.67,
    verdict: "listed",
    found: true,
  } as TrustAnswer;
  const scan: ScanResult = {
    packageName: "requests",
    scan: {
      score: 100,
      maxScore: 100,
      findings: [],
      timestamp: "2026-06-08T00:00:00Z",
    },
    trustScore: 1,
    trustLevel: 3,
    verdict: "safe",
  };

  it("a registry answer carries the ecosystem the target was checked under, after the name", () => {
    const json = buildCheckJson({ kind: "registry", answer, ecosystem: "pypi" });
    expect(json.ecosystem).toBe("pypi");
    expect(Object.keys(json).slice(0, 3)).toEqual(["name", "ecosystem", "source"]);
  });

  it("a scan result carries the ecosystem the target was checked under, after the name", () => {
    const json = buildCheckJson({ kind: "scan", scan, ecosystem: "pypi" });
    expect(json.ecosystem).toBe("pypi");
    expect(Object.keys(json).slice(0, 3)).toEqual(["name", "ecosystem", "source"]);
  });

  it("is omitted when no ecosystem is given (--scan-path)", () => {
    expect(buildCheckJson({ kind: "scan", scan })).not.toHaveProperty("ecosystem");
    expect(buildCheckJson({ kind: "registry", answer })).not.toHaveProperty("ecosystem");
  });
});

describe("version (#224)", () => {
  const tagged: ScanResult = {
    packageName: "is-odd@latest",
    packageVersion: "3.0.1",
    requestedVersion: "latest",
    scan: {
      score: 100,
      maxScore: 100,
      findings: [],
      timestamp: "2026-10-18T00:00:00Z",
      filesExamined: 2,
    },
    trustScore: 1,
    trustLevel: 3,
    verdict: "safe",
  };

  it("a scan carries the version the downloaded package's manifest names, after the ecosystem", () => {
    const json = buildCheckJson({ kind: "scan", scan: tagged, ecosystem: "npm" });
    expect(json.name).toBe("is-odd@latest");
    expect(json.version).toBe("3.0.1");
    expect(Object.keys(json).slice(0, 4)).toEqual(["name", "ecosystem", "version", "source"]);
  });

  it("a scan that read 0 files still names the version that was downloaded", () => {
    const empty: ScanResult = { ...tagged, scan: { ...tagged.scan, filesExamined: 0 } };
    const json = buildCheckJson({ kind: "scan", scan: empty, ecosystem: "npm" });
    expect(json.scored).toBe(false);
    expect(json.version).toBe("3.0.1");
  });

  it("is omitted when the manifest names no version, and for a registry answer", () => {
    const noVersion: ScanResult = { ...tagged, packageVersion: undefined };
    expect(buildCheckJson({ kind: "scan", scan: noVersion, ecosystem: "npm" })).not.toHaveProperty("version");
    const answer = { name: "is-odd", found: true, trustLevel: 3, trustScore: 0.9, verdict: "passed" } as TrustAnswer;
    expect(buildCheckJson({ kind: "registry", answer, ecosystem: "npm" })).not.toHaveProperty("version");
  });
});
