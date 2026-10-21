/**
 * Tests for output formatting functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatCheckResult,
  formatBatchResults,
  formatScanResult,
  formatJson,
  formatNotFound,
  showsRegistryScore,
} from "./formatter.js";
import type { TrustAnswer, BatchResponse } from "@opena2a/registry-client";
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
  it("shows not-found block when package is not in registry", () => {
    const answer = makeTrustAnswer({ found: false, name: "unknown-pkg" });
    const output = formatCheckResult(answer);

    expect(output).toContain("unknown-pkg");
    // cli-ui renderNotFoundBlock 0.3.0 header — shared across all three CLIs.
    expect(output).toContain("Package not found: unknown-pkg");
    expect(output).toContain("Next Steps");
    // The default check scans the package; --scan-if-missing is a no-op (#98).
    expect(output).toContain("ai-trust check unknown-pkg");
    expect(output).not.toContain("--scan-if-missing");
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
    // renderCheckBlock normalizes "mcp_server" -> "mcp server" in the header meta.
    expect(output).toContain("mcp server");
    // cli-ui 0.3.0 inlines the trust-level legend on every level (F5: Level
    // "always present; one truth"). Previously ai-trust hid the legend at
    // Level 4; the new shared contract always shows it so users see the full
    // scale alongside where the package sits.
    expect(output).toContain("Blocked > Warning");
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
    expect(output).toContain("Fresh scan  ai-trust check some-pkg");
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

  it("prints - and why for a trust level that is not a whole number (#238)", () => {
    const levelLine = (output: string) =>
      output.split("\n").find((line) => line.trimStart().startsWith("Level"));
    for (const trustLevel of ["\t1", "1", 1.5, true, { level: 1 }]) {
      const output = formatCheckResult(
        makeTrustAnswer({ trustLevel: trustLevel as unknown as number }),
      );

      expect(levelLine(output), JSON.stringify(trustLevel)).toBe(
        "  Level     - (the registry's trust level is not a whole number)",
      );
      expect(output, JSON.stringify(trustLevel)).not.toContain("undefined");
    }
    for (const trustLevel of [undefined, null]) {
      const output = formatCheckResult(
        makeTrustAnswer({ trustLevel: trustLevel as unknown as number }),
      );

      expect(levelLine(output), String(trustLevel)).toBe(
        "  Level     - (the registry's answer has no trust level)",
      );
    }
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

  it("renders not-found block even when packageType is missing", () => {
    const answer = makeTrustAnswer({ packageType: undefined, found: false });
    const output = formatCheckResult(answer);
    // Not-found path no longer fabricates an "unknown" type row. The header
    // alone names the package and ecosystem.
    expect(output).toContain("Package not found:");
    expect(output).toContain("test-package");
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

    // cli-ui renderCheckBlock emits "Listed — limited signal" for the
    // "listed" verdict; the old ai-trust-specific "Not yet security-scanned"
    // text was a local hand-rolled label that diverged from the shared
    // contract.
    expect(output).toContain("Listed");
    // F6: the meter is suppressed when scanStatus doesn't indicate a
    // completed scan, and a "not scanned" line is emitted instead.
    expect(output).toContain("not scanned");
    expect(output).not.toContain("0/100");
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

describe("formatCheckResult registry security profile (#105)", () => {
  // Shape of the registry answer for @modelcontextprotocol/server-filesystem
  // with includeProfile=true: verdict passed, scan status warnings, and a
  // profile that records one high finding.
  function withProfile(
    securityProfile: Record<string, unknown> | undefined,
    overrides: Partial<TrustAnswer> = {},
  ): TrustAnswer {
    return {
      ...makeTrustAnswer({
        name: "@modelcontextprotocol/server-filesystem",
        verdict: "passed",
        scanStatus: "warnings",
        ...overrides,
      }),
      securityProfile,
    } as TrustAnswer;
  }

  it("does not say 'No known issues' when the registry records a high finding", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: 0, highCount: 1, knownCves: [] }),
    );

    expect(output).not.toContain("No known issues");
    expect(output).toContain("Passed, but the registry recorded 1 high finding");
    expect(output).toMatch(
      /Findings\s+0 critical · 1 high \(details not returned\) · scan status warnings/,
    );
    expect(output).toMatch(/CVEs\s+none recorded/);
  });

  it("names critical findings and known CVEs in the headline and lists the CVEs", () => {
    const output = formatCheckResult(
      withProfile({
        criticalCount: 2,
        highCount: 1,
        knownCves: ["CVE-2025-0001", { id: "GHSA-aaaa-bbbb-cccc" }],
      }),
    );

    expect(output).toContain(
      "Passed, but the registry recorded 2 critical and 1 high finding, plus 2 known CVEs",
    );
    expect(output).toMatch(/Findings\s+2 critical · 1 high/);
    expect(output).toMatch(/CVEs\s+CVE-2025-0001, GHSA-aaaa-bbbb-cccc/);
  });

  it("caps the listed CVEs and counts the rest", () => {
    const knownCves = Array.from({ length: 7 }, (_, i) => `CVE-2025-000${i + 1}`);
    const output = formatCheckResult(
      withProfile({ criticalCount: 0, highCount: 0, knownCves }),
    );

    expect(output).toContain("Passed, but the registry recorded 7 known CVEs");
    expect(output).toContain("CVE-2025-0005 +2 more");
    expect(output).not.toContain("CVE-2025-0006");
  });

  it("keeps 'No known issues' and shows zero counts when the profile is clean", () => {
    const output = formatCheckResult(
      withProfile(
        { criticalCount: 0, highCount: 0, knownCves: [] },
        { scanStatus: "passed" },
      ),
    );

    expect(output).toContain("No known issues");
    expect(output).toMatch(/Findings\s+0 critical · 0 high · scan status passed/);
    expect(output).toMatch(/CVEs\s+none recorded/);
  });

  it("keeps the registry's warning headline and adds the counts", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: 1, highCount: 0, knownCves: [] }, { verdict: "warning" }),
    );

    expect(output).toContain("Warning");
    expect(output).not.toContain("Passed, but");
    expect(output).toMatch(/Findings\s+1 critical \(details not returned\) · 0 high/);
  });

  it("omits the Findings and CVEs lines when the registry returned no profile", () => {
    const output = formatCheckResult(withProfile(undefined, { scanStatus: "passed" }));

    expect(output).toContain("No known issues");
    expect(output).not.toContain("Findings");
    expect(output).not.toContain("CVEs");
  });

  it("omits the lines when the profile carries nothing readable", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: null, highCount: -1 }, { scanStatus: "passed" }),
    );

    expect(output).toContain("No known issues");
    expect(output).not.toContain("Findings");
    expect(output).not.toContain("CVEs");
  });

  it("lists a known CVE when the profile carries no counts (#129)", () => {
    const output = formatCheckResult(
      withProfile({ knownCves: ["CVE-2025-0001"] }, { scanStatus: "passed" }),
    );

    expect(output).not.toContain("No known issues");
    expect(output).toContain("Passed, but the registry recorded 1 known CVE");
    expect(output).toMatch(
      /Findings\s+critical not reported · high not reported · scan status passed/,
    );
    expect(output).toMatch(/CVEs\s+CVE-2025-0001/);
  });

  it("shows the high count when the critical count is invalid (#129)", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: null, highCount: 2 }, { scanStatus: "passed" }),
    );

    expect(output).not.toContain("No known issues");
    expect(output).toContain("Passed, but the registry recorded 2 high findings");
    expect(output).toMatch(
      /Findings\s+critical not reported · 2 high \(details not returned\) · scan status passed/,
    );
    expect(output).toMatch(/CVEs\s+none recorded/);
  });

  it("shows the critical count when the high count is invalid (#129)", () => {
    const output = formatCheckResult(
      withProfile(
        { criticalCount: "3", highCount: -1, knownCves: "CVE" },
        { scanStatus: "passed" },
      ),
    );

    expect(output).not.toContain("No known issues");
    expect(output).toContain(
      "Passed, but the registry recorded 3 critical findings, plus 1 known CVE",
    );
    expect(output).toMatch(
      /Findings\s+3 critical \(details not returned\) · high not reported · scan status passed/,
    );
    expect(output).toMatch(/CVEs\s+CVE\n/);
  });

  it("keeps 'No known issues' when the one reported count is zero", () => {
    const output = formatCheckResult(
      withProfile({ highCount: 0 }, { scanStatus: "passed" }),
    );

    expect(output).toContain("No known issues");
    expect(output).toMatch(/Findings\s+critical not reported · 0 high · scan status passed/);
  });

  it("does not say 'No known issues' when the scan status is warnings and the profile is clean (#129)", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: 0, highCount: 0, knownCves: [] }),
    );

    expect(output).not.toContain("No known issues");
    expect(output).toContain("Passed, but the registry's scan reported warnings");
    expect(output).toMatch(/Findings\s+0 critical · 0 high · scan status warnings/);
  });

  it("does not say 'No known issues' when the scan status is warnings and no profile came back (#129)", () => {
    const output = formatCheckResult(withProfile(undefined));

    expect(output).not.toContain("No known issues");
    expect(output).toContain("Passed, but the registry's scan reported warnings");
    expect(output).not.toContain("Findings");
  });

  it("names the recorded findings, not the scan status, when both apply", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: 0, highCount: 1, knownCves: [] }),
    );

    expect(output).toContain("Passed, but the registry recorded 1 high finding");
    expect(output).not.toContain("scan reported warnings");
  });

  it("keeps the registry's warning headline when the scan status is warnings", () => {
    const output = formatCheckResult(withProfile(undefined, { verdict: "warning" }));

    expect(output).toContain("Warning");
    expect(output).not.toContain("Passed, but");
  });

  it("omits the counts on a failed scan, whose counts are unreliable", () => {
    const output = formatCheckResult(
      withProfile({ criticalCount: 0, highCount: 1, knownCves: [] }, { scanStatus: "error" }),
    );

    expect(output).toContain("Scan failed");
    expect(output).not.toContain("Findings");
  });
});

describe("registry scan date and recorded findings", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // An hour past the day boundary, so the age does not depend on the clock.
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS - 60 * 60 * 1000).toISOString();

  // Shape of the registry answer for openai with includeProfile=true: verdict
  // passed, scan status warnings, one high finding and no scan date.
  function openaiAnswer(overrides: Partial<TrustAnswer> = {}): TrustAnswer {
    return {
      ...makeTrustAnswer({
        name: "openai",
        trustScore: 0.71,
        verdict: "passed",
        scanStatus: "warnings",
        ...overrides,
      }),
      securityProfile: { criticalCount: 0, highCount: 1, knownCves: [] },
    } as TrustAnswer;
  }

  it("says the scan date is not recorded when the answer carries none", () => {
    const header = formatCheckResult(openaiAnswer()).split("\n")[1];

    expect(header).toContain("openai");
    expect(header).toContain("scan date not recorded");
    expect(header).not.toContain("scanned");
  });

  it("says the scan date is not recorded when the answer's date does not parse", () => {
    const output = formatCheckResult(openaiAnswer({ lastScannedAt: "not-a-date" }));

    expect(output).toContain("scan date not recorded");
    expect(output).not.toContain("NaN");
  });

  it("keeps the scan age when the answer carries a date", () => {
    const output = formatCheckResult(openaiAnswer({ lastScannedAt: daysAgo(228) }));

    expect(output).toContain("scanned 228 days ago (stale)");
    expect(output).not.toContain("scan date not recorded");
  });

  // "scan date not recorded" over "Trust  not scanned" implied a scan that
  // never happened (#230).
  it("says not scanned in the header of a package whose scan status names no scan", () => {
    for (const scanStatus of [undefined, "", "pending", "queued"]) {
      const header = formatCheckResult(
        makeTrustAnswer({ name: "mcp-server-kubernetes", trustLevel: 2, verdict: "listed", scanStatus }),
      ).split("\n")[1];

      expect(header, String(scanStatus)).toContain("mcp-server-kubernetes");
      expect(header, String(scanStatus)).toContain("not scanned");
      expect(header, String(scanStatus)).not.toContain("scan date not recorded");
    }
  });

  it("keeps scan date not recorded for a failed scan without a date", () => {
    const header = formatCheckResult(makeTrustAnswer({ scanStatus: "failed" })).split("\n")[1];

    expect(header).toContain("scan date not recorded");
  });

  // The Next Steps scan dropped the version of a `<name>@<version>` target
  // (#230).
  it("cites the version a target gave in the Next Steps scan", () => {
    const npmOutput = formatCheckResult(
      makeTrustAnswer({ name: "@modelcontextprotocol/server-filesystem", trustLevel: 3 }),
      "npm",
      { version: "2026.7.10" },
    );
    expect(npmOutput).toContain("ai-trust check @modelcontextprotocol/server-filesystem@2026.7.10");

    const pypiOutput = formatCheckResult(makeTrustAnswer({ name: "mcp-server-fetch" }), "pypi", {
      version: "1.0.0",
    });
    expect(pypiOutput).toContain("ai-trust check pip:mcp-server-fetch@1.0.0");

    const unversioned = formatCheckResult(makeTrustAnswer({ name: "plain-mcp", trustLevel: 3 }));
    expect(unversioned).toMatch(/ai-trust check plain-mcp$/m);
  });

  it("says a recorded high finding's details are not returned, and names the scan that re-measures it", () => {
    const output = formatCheckResult(openaiAnswer());

    expect(output).toMatch(
      /Findings\s+0 critical · 1 high \(details not returned\) · scan status warnings\n/,
    );
    expect(output).toContain("Fresh scan  ai-trust check openai");
  });

  it("puts the note after the last recorded count", () => {
    const both = {
      ...openaiAnswer(),
      securityProfile: { criticalCount: 2, highCount: 1, knownCves: [] },
    } as TrustAnswer;
    const criticalOnly = {
      ...openaiAnswer(),
      securityProfile: { criticalCount: 2, highCount: 0, knownCves: [] },
    } as TrustAnswer;

    expect(formatCheckResult(both)).toMatch(
      /Findings\s+2 critical · 1 high \(details not returned\) · scan status warnings\n/,
    );
    expect(formatCheckResult(criticalOnly)).toMatch(
      /Findings\s+2 critical \(details not returned\) · 0 high · scan status warnings\n/,
    );
  });

  it("re-measures a pip: target as the PyPI package", () => {
    const output = formatCheckResult(openaiAnswer(), "pypi");

    expect(output).toContain("Fresh scan  ai-trust check pip:openai");
  });

  it("quotes a registry name with shell syntax in the re-measure command", () => {
    const pypi = formatCheckResult(openaiAnswer({ name: "evil; echo injected" }), "pypi");

    expect(pypi).toContain("Fresh scan  ai-trust check 'pip:evil; echo injected'");
  });

  it("adds no note when the registry records no critical or high finding", () => {
    const answer = {
      ...openaiAnswer(),
      securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
    } as TrustAnswer;

    expect(formatCheckResult(answer)).not.toContain("details not returned");
  });

  it("adds no note on a failed scan, whose counts are unreliable", () => {
    expect(formatCheckResult(openaiAnswer({ scanStatus: "error" }))).not.toContain(
      "details not returned",
    );
  });
});

describe("a registry answer with a scan date and a scan status that is not a finished one", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // An hour past the day boundary, so the age does not depend on the clock.
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS - 60 * 60 * 1000).toISOString();
  const trustLine = (output: string) =>
    output.split("\n").find((line) => line.trimStart().startsWith("Trust"));

  // Listed, a score, a scan date 231 days back, one recorded high finding and
  // scan status pending: the fields of the registry's answer for
  // @upstash/context7-mcp.
  function pendingAnswer(overrides: Partial<TrustAnswer> = {}): TrustAnswer {
    return {
      ...makeTrustAnswer({
        name: "@upstash/context7-mcp",
        trustLevel: 2,
        trustScore: 0.773,
        verdict: "listed",
        scanStatus: "pending",
        lastScannedAt: daysAgo(231),
        ...overrides,
      }),
      securityProfile: { criticalCount: 0, highCount: 1, knownCves: [] },
    } as TrustAnswer;
  }

  it("says the score is not shown, with the scan status and the age of the last recorded scan", () => {
    const output = formatCheckResult(pendingAnswer());
    const trust = trustLine(output);

    expect(trust).toContain("pending");
    expect(trust).toContain("231 days ago (stale)");
    expect(trust).toBe(
      "  Trust     score not shown: the registry's scan status is pending · last recorded scan 231 days ago (stale)",
    );
    // The same age the header prints.
    expect(output.split("\n")[1]).toContain("scanned 231 days ago (stale)");
    expect(output).not.toContain("not scanned");
    expect(output).not.toContain("request a scan");
  });

  it("shows no score for it, and the Next Steps scan measures the package now", () => {
    const output = formatCheckResult(pendingAnswer());

    expect(trustLine(output)).not.toMatch(/\/100/);
    expect(output).not.toContain("77/100");
    expect(output).toContain("Scan locally  ai-trust check @upstash/context7-mcp");
  });

  it("names the status word the registry sent", () => {
    for (const scanStatus of ["not_applicable", "running", "PENDING"]) {
      const output = formatCheckResult(pendingAnswer({ scanStatus }));

      expect(trustLine(output), scanStatus).toContain(
        `score not shown: the registry's scan status is ${scanStatus} · last recorded scan 231 days ago (stale)`,
      );
      expect(output, scanStatus).not.toContain("not scanned");
    }
  });

  it("says the answer has no scan status when the status is empty", () => {
    for (const scanStatus of ["", "  ", undefined]) {
      const output = formatCheckResult(pendingAnswer({ scanStatus }));

      expect(trustLine(output), JSON.stringify(scanStatus)).toBe(
        "  Trust     score not shown: the registry's answer has no scan status · last recorded scan 231 days ago (stale)",
      );
    }
  });

  it("says the scan status is not a string when the registry sent another type (#238)", () => {
    for (const scanStatus of [0, false, 5, true, { state: "passed" }, ["passed"]]) {
      const output = formatCheckResult(
        pendingAnswer({ scanStatus: scanStatus as unknown as string }),
      );

      expect(trustLine(output), JSON.stringify(scanStatus)).toBe(
        "  Trust     score not shown: the registry's scan status is not a string · last recorded scan 231 days ago (stale)",
      );
      // The Findings line names no scan status for it.
      expect(output, JSON.stringify(scanStatus)).toMatch(
        /^ {2}Findings {2}0 critical · 1 high \(details not returned\)$/m,
      );
    }
  });

  it("says the answer has no scan status when the status is null (#238)", () => {
    const output = formatCheckResult(pendingAnswer({ scanStatus: null as unknown as string }));

    expect(trustLine(output)).toBe(
      "  Trust     score not shown: the registry's answer has no scan status · last recorded scan 231 days ago (stale)",
    );
  });

  it("says not scanned for a scan status of another type when the answer carries no scan date (#238)", () => {
    for (const scanStatus of [0, 5, { state: "passed" }]) {
      const output = formatCheckResult(
        pendingAnswer({ scanStatus: scanStatus as unknown as string, lastScannedAt: undefined }),
      );

      expect(trustLine(output), JSON.stringify(scanStatus)).toContain("not scanned");
      expect(output, JSON.stringify(scanStatus)).not.toContain("77/100");
    }
  });

  it("still says not scanned when the answer carries no scan date, or one that does not parse", () => {
    for (const lastScannedAt of [undefined, "not-a-date"]) {
      const output = formatCheckResult(pendingAnswer({ lastScannedAt }));

      expect(trustLine(output), String(lastScannedAt)).toContain("not scanned");
      expect(trustLine(output), String(lastScannedAt)).not.toContain("score not shown");
    }
  });

  it("still draws the meter for a finished scan, and says a failed scan failed", () => {
    for (const scanStatus of ["passed", "warnings"]) {
      expect(trustLine(formatCheckResult(pendingAnswer({ scanStatus }))), scanStatus).toContain(
        "77/100",
      );
    }
    expect(trustLine(formatCheckResult(pendingAnswer({ scanStatus: "failed" })))).toContain(
      "Scan failed",
    );
  });
});

describe("registry score beside a fresh scan", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS - 60 * 60 * 1000).toISOString();

  function scanWithScore(score: number, overrides: Partial<ScanResult["scan"]> = {}): ScanResult {
    return {
      packageName: "@modelcontextprotocol/server-filesystem",
      trustScore: score / 100,
      trustLevel: 3,
      verdict: "safe",
      scan: {
        score,
        maxScore: 100,
        findings: [],
        projectType: "mcp",
        timestamp: new Date().toISOString(),
        checksEvaluated: 40,
        ...overrides,
      },
    };
  }

  function registryAnswer(trustScore: number, overrides: Partial<TrustAnswer> = {}): TrustAnswer {
    return makeTrustAnswer({
      name: "@modelcontextprotocol/server-filesystem",
      trustScore,
      verdict: "passed",
      scanStatus: "warnings",
      lastScannedAt: daysAgo(228),
      ...overrides,
    });
  }

  it("prints both scores and both dates when they differ by more than 20 points", () => {
    const output = formatScanResult(scanWithScore(100), {
      remote: true,
      registry: registryAnswer(0.79),
    });

    expect(output).toContain("Registry 79/100 (scanned 228 days ago) vs this scan 100/100 (today)");
  });

  it("prints the gap when this scan scores lower than the registry", () => {
    const output = formatScanResult(scanWithScore(60), {
      remote: true,
      registry: registryAnswer(0.95),
    });

    expect(output).toContain("Registry 95/100 (scanned 228 days ago) vs this scan 60/100 (today)");
  });

  it("prints no gap line when the scores are 20 points apart or closer", () => {
    const close = formatScanResult(scanWithScore(100), { remote: true, registry: registryAnswer(0.95) });
    const edge = formatScanResult(scanWithScore(100), { remote: true, registry: registryAnswer(0.8) });

    expect(close).not.toContain("vs this scan");
    expect(edge).not.toContain("vs this scan");
  });

  it("says the registry's scan date is not recorded when the answer carries none", () => {
    const output = formatScanResult(scanWithScore(100), {
      remote: true,
      registry: registryAnswer(0.71, { lastScannedAt: undefined }),
    });

    expect(output).toContain("Registry 71/100 (scan date not recorded) vs this scan 100/100 (today)");
  });

  it("prints no gap line without a registry answer", () => {
    expect(formatScanResult(scanWithScore(100), { remote: true })).not.toContain("vs this scan");
  });

  it("prints no gap line when the registry's scan failed or has no score", () => {
    for (const scanStatus of ["error", "failed", "pending"]) {
      const output = formatScanResult(scanWithScore(100), {
        remote: true,
        registry: registryAnswer(0.3, { scanStatus }),
      });
      expect(output, scanStatus).not.toContain("vs this scan");
    }
  });

  it("prints no gap line when the registry's score is not a number from 0 to 1", () => {
    const output = formatScanResult(scanWithScore(100), {
      remote: true,
      registry: registryAnswer(55),
    });

    expect(output).not.toContain("vs this scan");
  });

  it("prints no gap line when the registry's scan status is not a string (#238)", () => {
    for (const scanStatus of [5, true, { state: "passed" }]) {
      const answer = registryAnswer(0.3, { scanStatus: scanStatus as unknown as string });
      const scan = scanWithScore(100);

      expect(
        formatScanResult(scan, { remote: true, registry: answer }),
        JSON.stringify(scanStatus),
      ).not.toContain("vs this scan");
      expect(showsRegistryScore(answer, scan), JSON.stringify(scanStatus)).toBe(false);
    }
  });

  it("prints no gap line when this scan had nothing to analyze", () => {
    const output = formatScanResult(scanWithScore(100, { checksEvaluated: 0 }), {
      remote: true,
      registry: registryAnswer(0.3),
    });

    expect(output).not.toContain("vs this scan");
  });

  it("showsRegistryScore says whether the scan output prints the gap line (#224)", () => {
    const cases: Array<[string, ScanResult, TrustAnswer, boolean]> = [
      ["more than 20 points apart", scanWithScore(100), registryAnswer(0.79), true],
      ["scan lower than the registry", scanWithScore(60), registryAnswer(0.95), true],
      ["no registry scan date", scanWithScore(100), registryAnswer(0.71, { lastScannedAt: undefined }), true],
      ["20 points apart", scanWithScore(100), registryAnswer(0.8), false],
      ["registry scan failed", scanWithScore(100), registryAnswer(0.3, { scanStatus: "failed" }), false],
      ["registry score off the 0-1 scale", scanWithScore(100), registryAnswer(55), false],
      ["nothing to analyze", scanWithScore(100, { checksEvaluated: 0 }), registryAnswer(0.3), false],
      ["0 files read", scanWithScore(100, { filesExamined: 0 }), registryAnswer(0.3), false],
      ["registry has no such package", scanWithScore(100), registryAnswer(0.3, { found: false }), false],
    ];
    for (const [label, scan, answer, shown] of cases) {
      const output = formatScanResult(scan, { remote: true, registry: answer });
      expect(output.includes("vs this scan"), label).toBe(shown);
      expect(showsRegistryScore(answer, scan), label).toBe(shown);
    }
  });
});

describe("the version a tag or range resolved to (#224)", () => {
  function downloaded(
    packageName: string,
    versions: { requestedVersion?: string; packageVersion?: string },
  ): ScanResult {
    return {
      packageName,
      ...versions,
      trustScore: 1,
      trustLevel: 3,
      verdict: "safe",
      scan: {
        score: 100,
        maxScore: 100,
        findings: [],
        projectType: "library",
        timestamp: new Date().toISOString(),
        checksEvaluated: 40,
      },
    };
  }

  it("names the version a tag or a range resolved to after the target in the header", () => {
    const tag = formatScanResult(
      downloaded("is-odd@latest", { requestedVersion: "latest", packageVersion: "3.0.1" }),
      { remote: true },
    );
    const range = formatScanResult(
      downloaded("is-odd@1.x", { requestedVersion: "1.x", packageVersion: "1.0.1" }),
      { remote: true },
    );

    expect(tag).toContain("  is-odd@latest (3.0.1)  downloaded package");
    expect(range).toContain("  is-odd@1.x (1.0.1)  downloaded package");
  });

  it("puts the version before the ecosystem of a pip: target", () => {
    const output = formatScanResult(
      downloaded("requests@2.0", { requestedVersion: "2.0", packageVersion: "2.0.0" }),
      { remote: true, ecosystem: "pypi" },
    );

    expect(output).toContain("  requests@2.0 (2.0.0) (pypi)  downloaded package");
  });

  it("adds nothing when the target named the version downloaded, named none, or the manifest has none", () => {
    const exact = formatScanResult(
      downloaded("is-odd@3.0.1", { requestedVersion: "3.0.1", packageVersion: "3.0.1" }),
      { remote: true },
    );
    const bare = formatScanResult(downloaded("is-odd", { packageVersion: "3.0.1" }), { remote: true });
    const unread = formatScanResult(downloaded("is-odd@latest", { requestedVersion: "latest" }), { remote: true });

    expect(exact).toContain("  is-odd@3.0.1  downloaded package");
    expect(bare).toContain("  is-odd  downloaded package");
    expect(unread).toContain("  is-odd@latest  downloaded package");
    for (const output of [exact, bare, unread]) expect(output).not.toContain("(3.0.1)");
  });
});

describe("control characters in registry strings are removed from text output (#129)", () => {
  // C0 controls, DEL and C1 controls. The test mocks chalk, so the formatter
  // adds no escape sequence of its own and any match came from the answer.
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  const OSC_TITLE = "\u001b]0;x\u0007";

  function printedLines(output: string): string[] {
    return output.split("\n");
  }

  it("strips them from a listed CVE and prints no extra line", () => {
    const answer = {
      ...makeTrustAnswer({ name: "ctrl-pkg", verdict: "passed", scanStatus: "passed" }),
      securityProfile: {
        criticalCount: 0,
        highCount: 0,
        knownCves: [`CVE-${OSC_TITLE}-1\r\nEXTRA LINE`],
      },
    } as TrustAnswer;
    const clean = {
      ...answer,
      securityProfile: { criticalCount: 0, highCount: 0, knownCves: ["CVE-2025-0001"] },
    } as TrustAnswer;
    const output = formatCheckResult(answer);

    for (const line of printedLines(output)) expect(line).not.toMatch(CONTROL);
    expect(printedLines(output)).toHaveLength(printedLines(formatCheckResult(clean)).length);
    expect(output).toMatch(/CVEs\s+CVE-\]0;x-1 EXTRA LINE\n/);
  });

  it("strips them from the name, package type and scan status of a check result", () => {
    const answer = {
      ...makeTrustAnswer({
        name: `evil${OSC_TITLE}-pkg\r\nSECOND`,
        packageType: `mcp_server\u001b[2J`,
        verdict: "passed",
        scanStatus: "passed\u009b31m",
      }),
      securityProfile: { criticalCount: 0, highCount: 0, knownCves: [] },
    } as TrustAnswer;
    const output = formatCheckResult(answer);

    for (const line of printedLines(output)) expect(line).not.toMatch(CONTROL);
    expect(output).toContain("evil]0;x-pkg SECOND");
    expect(output).toContain("scan status passed31m");
  });

  it("strips them from the name of a package the registry does not have", () => {
    const output = formatCheckResult(
      makeTrustAnswer({ found: false, name: `gone${OSC_TITLE}\r\nSECOND` }),
    );

    for (const line of printedLines(output)) expect(line).not.toMatch(CONTROL);
    expect(output).toContain("Package not found: gone]0;x SECOND");
  });

  it("cuts a listed advisory identifier longer than 40 characters", () => {
    const long = `CVE-${"9".repeat(60)}`;
    const answer = {
      ...makeTrustAnswer({ verdict: "passed", scanStatus: "passed" }),
      securityProfile: { criticalCount: 0, highCount: 0, knownCves: [long, "CVE-2025-0001"] },
    } as TrustAnswer;
    const output = formatCheckResult(answer);

    expect(output).not.toContain(long);
    expect(output).toMatch(new RegExp(`CVEs\\s+CVE-9{33}\\.\\.\\., CVE-2025-0001\\n`));
  });

  it("strips them from the name, type and scan status in the batch table and summary", () => {
    const response: BatchResponse = {
      results: [
        makeTrustAnswer({
          name: `row${OSC_TITLE}\r\nSECOND`,
          packageType: "mcp_server\u0007",
          trustLevel: 1,
          verdict: "warning",
          scanStatus: "warnings\u001b[1m",
        }),
        makeTrustAnswer({ name: `lib\u001b[2J-name`, packageType: "library" }),
        makeTrustAnswer({ name: `miss\u0007ing`, packageType: "mcp_server", found: false }),
      ],
      meta: { total: 3, found: 2, notFound: 1 },
    };
    const output = formatBatchResults(response, 3);

    for (const line of printedLines(output)) expect(line).not.toMatch(CONTROL);
    expect(output).toContain("row]0;x SECOND");
    expect(output).toContain("lib[2J-name");
    expect(output).toContain("missing");
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

    expect(output).toContain("AI package");
    expect(output).toContain("audited");
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

  it("shows 'not scanned' instead of 0/100 for an unscanned package below the threshold", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "unscanned-pkg",
        trustLevel: 2,
        trustScore: 0,
        verdict: "listed",
        scanStatus: "",
      }),
    ]);
    const output = formatBatchResults(response, 3);

    const summaryLine = output
      .split("\n")
      .find((l) => l.includes("│") && l.includes("unscanned-pkg"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain("not scanned");
    expect(summaryLine).toContain("Listed (2/4)");
    expect(output).not.toContain("0/100");
  });

  it("shows no score for a found package whose scan status is in progress (#129)", () => {
    for (const scanStatus of ["running", "queued", "in_progress", "Scanning"]) {
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "running-mcp",
          trustLevel: 2,
          trustScore: 0,
          verdict: "listed",
          scanStatus,
        }),
      ]);
      const output = formatBatchResults(response, 3);
      const lines = output.split("\n");

      const tableRow = lines.find((l) => l.includes("running-mcp") && l.includes("LISTED"));
      // "--" and no meter: an empty meter reads as a full one without color.
      expect(tableRow, scanStatus).toMatch(/ --\s+\S/);
      expect(tableRow, scanStatus).not.toContain("━");
      expect(tableRow, scanStatus).toContain(scanStatus);
      const summaryLine = lines.find((l) => l.includes("│") && l.includes("running-mcp"));
      expect(summaryLine, scanStatus).toContain("not scanned");
      expect(output, scanStatus).not.toContain("0/100");
    }
  });

  it("shows no score and - for a scan status that is not a string (#238)", () => {
    for (const scanStatus of [5, true, { state: "passed" }, 0, false]) {
      const label = JSON.stringify(scanStatus);
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "odd-status",
          trustLevel: 2,
          trustScore: 0.9,
          verdict: "listed",
          scanStatus: scanStatus as unknown as string,
        }),
      ]);
      const output = formatBatchResults(response, 3);
      const lines = output.split("\n");

      // SCORE is "--", after an empty meter or with none, and "-" fills the
      // SCAN column.
      expect(lines.find((l) => l.startsWith("  odd-status")), label).toMatch(/ (?:━{8} )?-- +- {9}$/);
      expect(lines.find((l) => l.includes("│") && l.includes("odd-status")), label).toContain(
        "not scanned  Listed (2/4)",
      );
      expect(output, label).not.toContain("90/100");
    }
  });

  it("prints - for a trust level that is not a whole number, in the table and the summary (#238)", () => {
    for (const trustLevel of ["\t1", " 1", 1.5, null, true]) {
      const label = JSON.stringify(trustLevel);
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "odd-level",
          trustLevel: trustLevel as unknown as number,
          trustScore: 0,
          verdict: "listed",
          scanStatus: "warnings",
        }),
      ]);
      const lines = formatBatchResults(response, 2).split("\n");

      expect(lines.find((l) => l.startsWith("  odd-level")), label).toMatch(
        /^ {2}odd-level\s+mcp_server\s+LISTED\s+- {11}\S/,
      );
      // The gate reads each of these as below level 2.
      expect(lines.find((l) => l.includes("│") && l.includes("odd-level")), label).toMatch(
        / {2}level unavailable$/,
      );
    }
  });

  it("prints - for a trust level that is not a number, and the shared label for a whole number off the scale (#238)", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "text-level", trustLevel: "x" as unknown as number }),
      makeTrustAnswer({ name: "high-level", trustLevel: 7 }),
    ]);
    const lines = formatBatchResults(response, 2).split("\n");

    expect(lines.find((l) => l.startsWith("  text-level"))).toMatch(
      /^ {2}text-level\s+mcp_server\s+SAFE\s+- {11}\S/,
    );
    expect(lines.find((l) => l.startsWith("  high-level"))).toMatch(
      /^ {2}high-level\s+mcp_server\s+SAFE\s+Unknown \(7\) \S/,
    );
  });

  it("keeps the score for the scan statuses that name a finished scan", () => {
    for (const scanStatus of ["passed", "warnings", "warning", "complete", "completed", "local"]) {
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "scanned-pkg",
          trustLevel: 1,
          trustScore: 0.42,
          verdict: "warning",
          scanStatus,
        }),
      ]);
      const output = formatBatchResults(response, 3);

      const summaryLine = output
        .split("\n")
        .find((l) => l.includes("│") && l.includes("scanned-pkg"));
      expect(summaryLine, scanStatus).toContain("42/100");
      expect(summaryLine, scanStatus).not.toContain("not scanned");
    }
  });

  it("keeps the score meter for a scanned package below the threshold", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({
        name: "scanned-pkg",
        trustLevel: 1,
        trustScore: 0.42,
        verdict: "warning",
        scanStatus: "warnings",
      }),
    ]);
    const output = formatBatchResults(response, 3);

    const summaryLine = output
      .split("\n")
      .find((l) => l.includes("│") && l.includes("scanned-pkg"));
    expect(summaryLine).toContain("42/100");
    expect(summaryLine).not.toContain("not scanned");
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
    expect(output).toContain("ai-trust check missing-pkg");
    expect(output).not.toContain("<name>");
  });

  it("shows all-clear message when everything passes", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "good-pkg", trustLevel: 4 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("The AI package meets minimum trust level 3");
  });

  it("shows the library step after batch results that list libraries", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "pkg-a", trustLevel: 3 }),
      makeTrustAnswer({ name: "express", packageType: "library", trustLevel: 3 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("Next Steps");
    expect(output).toContain("npx hackmyagent secure");
  });

  // Every run ended with "Library security: npx hackmyagent secure .", a
  // step for libraries it had not listed (#230).
  it("prints no library step, and no Next Steps section, when there is nothing left to do", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "pkg-a", trustLevel: 3 }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("The AI package meets minimum trust level 3");
    expect(output).not.toContain("npx hackmyagent secure");
    expect(output).not.toContain("Next Steps");
  });

  it("shows check suggestion when packages are below threshold", () => {
    const response = makeBatchResponse([
      makeTrustAnswer({ name: "risky-pkg", trustLevel: 1, verdict: "warning" }),
    ]);
    const output = formatBatchResults(response, 3);

    expect(output).toContain("ai-trust check risky-pkg");
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

  it("truncates long package names on a terminal", () => {
    const longName = "a".repeat(50);
    const response = makeBatchResponse([
      makeTrustAnswer({ name: longName }),
    ]);
    const output = formatBatchResults(response, 3, { terminalWidth: 120 });

    expect(output).toContain("...");
  });

  // Piped output cut each name longer than 34 characters to its first 31 and
  // "..." (#230).
  it("prints every name whole when stdout is not a terminal, and lines the columns up after the longest", () => {
    const longName = "@modelcontextprotocol/server-filesystem-with-a-long-suffix";
    const response = makeBatchResponse([
      makeTrustAnswer({ name: longName, packageType: "mcp_server", trustLevel: 3, scanStatus: "warnings" }),
      makeTrustAnswer({ name: "short-mcp", packageType: "mcp_server", trustLevel: 3, scanStatus: "warnings" }),
    ]);
    const lines = formatBatchResults(response, 3).split("\n");

    expect(lines.join("\n")).not.toContain("...");
    const header = lines.find((l) => l.includes("PACKAGE"))!;
    const longRow = lines.find((l) => l.includes(longName))!;
    const shortRow = lines.find((l) => l.includes("short-mcp"))!;
    expect(header.indexOf("TYPE")).toBe(longRow.indexOf("mcp_server"));
    expect(header.indexOf("TYPE")).toBe(shortRow.indexOf("mcp_server"));
    expect(header.indexOf("TYPE")).toBeGreaterThan(2 + longName.length);
  });

  it("does not cut a surrogate pair in half when it shortens a name (#198)", () => {
    // The emoji's two code units sit at indexes 30 and 31; a cut at 31 would
    // keep only its high half.
    const longName = "mcp-server-" + "a".repeat(19) + "\u{1F600}bbbbbbbb";
    const response = makeBatchResponse([
      makeTrustAnswer({ name: longName, packageType: "mcp_server" }),
    ]);
    const output = formatBatchResults(response, 3, { terminalWidth: 120 });

    expect(output).toContain(`mcp-server-${"a".repeat(19)}...`);
    // With the u flag, \p{Cs} matches only a surrogate that is not in a pair.
    expect(output).not.toMatch(/\p{Cs}/u);
  });

  describe("columns and Next Steps of the table (#230)", () => {
    function stepLines(output: string): string[] {
      const lines = output.split("\n");
      const start = lines.findIndex((l) => l.includes("Next Steps"));
      return start === -1 ? [] : lines.slice(start + 1).filter((l) => l.trim() !== "");
    }

    it("lines SCAN up under its header after a meter, after --, and for a status longer than the column", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "scored-mcp", trustLevel: 3, trustScore: 0.79, scanStatus: "warnings" }),
        makeTrustAnswer({ name: "full-mcp", trustLevel: 4, trustScore: 1, scanStatus: "passed" }),
        makeTrustAnswer({ name: "unscanned-mcp", trustLevel: 2, verdict: "listed", scanStatus: "" }),
        makeTrustAnswer({ name: "na-mcp", trustLevel: 2, verdict: "listed", scanStatus: "not_applicable" }),
      ]);
      const lines = formatBatchResults(response, 2).split("\n");
      const header = lines.find((l) => l.includes("PACKAGE"))!;
      const scanAt = header.indexOf("SCAN");
      const rule = lines[lines.indexOf(header) + 1];

      expect(lines.find((l) => l.includes("scored-mcp"))!.indexOf("warnings")).toBe(scanAt);
      expect(lines.find((l) => l.includes("full-mcp"))!.indexOf("passed")).toBe(scanAt);
      const unscanned = lines.find((l) => l.includes("unscanned-mcp"))!;
      expect(unscanned.indexOf(" -", scanAt - 1) + 1).toBe(scanAt);
      expect(unscanned).not.toContain("━");
      const na = lines.find((l) => l.includes("na-mcp"))!;
      expect(na.indexOf("not_applicable")).toBe(scanAt);
      // The rule under the header reaches past the longest status.
      expect(rule.trimEnd().length).toBeGreaterThanOrEqual(scanAt + "not_applicable".length);
    });

    it("names each flagged, unclassified and missing package, quoted for the shell", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "@scope/flagged-mcp", trustLevel: 1, verdict: "warning" }),
        makeTrustAnswer({ name: "flagged; echo injected", trustLevel: 1, verdict: "warning", packageType: "mcp_server" }),
        makeTrustAnswer({ name: "missing-mcp", found: false, packageType: "mcp_server" }),
        makeTrustAnswer({ name: "novel-random-pkg", found: false, packageType: undefined }),
      ]);
      const steps = stepLines(formatBatchResults(response, 3, { file: "package.json" }));

      expect(steps).toEqual([
        "  Scan missing:      ai-trust audit package.json --scan-missing",
        "  Check individual:  ai-trust check missing-mcp",
        "  Inspect flagged:   ai-trust check @scope/flagged-mcp",
        "                     ai-trust check 'flagged; echo injected'",
        "  Classify unknown:  ai-trust check novel-random-pkg",
      ]);
    });

    it("cites a PyPI name with its pip: prefix and the file audit read", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "mcp-server-fetch", trustLevel: 1, verdict: "warning" }),
        makeTrustAnswer({ name: "missing-mcp", found: false }),
      ]);
      const steps = stepLines(
        formatBatchResults(response, 3, { file: "dev requirements.txt", ecosystem: "pypi" }),
      );

      expect(steps).toEqual([
        "  Scan missing:      ai-trust audit 'dev requirements.txt' --scan-missing",
        "  Check individual:  ai-trust check pip:missing-mcp",
        "  Inspect flagged:   ai-trust check pip:mcp-server-fetch",
      ]);
    });

    it("keeps <file> for batch, which reads no file", () => {
      const response = makeBatchResponse([makeTrustAnswer({ name: "missing-mcp", found: false })]);

      expect(stepLines(formatBatchResults(response, 3))[0]).toBe(
        "  Scan missing:      ai-trust audit <file> --scan-missing",
      );
    });

    it("does not offer audit's scan again after audit scanned the missing packages", () => {
      const response = makeBatchResponse([makeTrustAnswer({ name: "missing-mcp", found: false })]);
      const output = formatBatchResults(response, 3, { file: "package.json", scannedMissing: true });

      expect(stepLines(output)).toEqual(["  Check individual:  ai-trust check missing-mcp"]);
      expect(output).toContain("  Next: ai-trust check missing-mcp");
      expect(output).not.toContain("--scan-missing");
    });

    it("lists three commands and counts the rest, which the sections above name", () => {
      const response = makeBatchResponse(
        ["a", "b", "c", "d", "e"].map((x) =>
          makeTrustAnswer({ name: `flagged-${x}-mcp`, trustLevel: 1, verdict: "warning" }),
        ),
      );
      const steps = stepLines(formatBatchResults(response, 3));

      expect(steps).toEqual([
        "  Inspect flagged:   ai-trust check flagged-a-mcp",
        "                     ai-trust check flagged-b-mcp",
        "                     ai-trust check flagged-c-mcp",
        "                     + 2 more, listed above",
      ]);
    });

    it("names the unclassified packages of a run with no AI package", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "express", packageType: "library" }),
        makeTrustAnswer({ name: "novel-random-pkg", found: false, packageType: undefined }),
      ]);
      const steps = stepLines(formatBatchResults(response, 3));

      expect(steps).toEqual([
        "  General security scan:  npx hackmyagent secure .",
        "  Check an AI package:    ai-trust check novel-random-pkg",
      ]);
    });
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

  describe("tier partitioning (v0.3)", () => {
    it("partitions libraries into the Out of scope section", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3 }),
        makeTrustAnswer({ name: "express", packageType: "library", trustLevel: 2, verdict: "listed" }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("1 AI package");
      expect(output).toContain("1 library out of scope");
      expect(output).toContain("Out of scope (libraries)");
      expect(output).toContain("express");
      // The library does NOT appear in the main trust table header area
      expect(output).toContain("my-mcp");
    });

    it("shows friendly message when only libraries are present", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "express", packageType: "library" }),
        makeTrustAnswer({ name: "typescript", packageType: "library" }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("No AI packages found");
      expect(output).toContain("hackmyagent");
      expect(output).not.toContain("PACKAGE  ");
    });

    it("lists the library names under Out of scope when only libraries are present", () => {
      const names = ["react", "vue", "express", "lodash", "chalk"];
      const response = makeBatchResponse(
        names.map((name) => makeTrustAnswer({ name, packageType: "library" }))
      );
      const output = formatBatchResults(response, 3);

      expect(output).toContain("No AI packages found in 5 dependencies");
      expect(output).toContain("Out of scope (libraries)");
      for (const name of names) {
        expect(output).toContain(name);
      }
      expect(output.indexOf("Out of scope (libraries)")).toBeLessThan(
        output.indexOf("Next Steps")
      );
    });

    const eightLibraries = [
      "react", "vue", "express", "lodash", "chalk", "axios", "moment", "underscore",
    ];

    function outOfScopeLine(output: string): string {
      const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      const header = lines.findIndex((l) => l.includes("Out of scope (libraries)"));
      return lines.slice(header + 1).find((l) => l.includes("react")) ?? "";
    }

    it("names the first six libraries and counts the rest when only libraries are present", () => {
      const response = makeBatchResponse(
        eightLibraries.map((name) => makeTrustAnswer({ name, packageType: "library" }))
      );
      const output = formatBatchResults(response, 3);

      expect(outOfScopeLine(output).trim()).toBe(
        "react, vue, express, lodash, chalk, axios + 2 more"
      );
      expect(output).not.toContain("moment");
      expect(output).not.toContain("underscore");
    });

    it("names the first six libraries and counts the rest in the mixed-batch footer", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3 }),
        ...eightLibraries.map((name) =>
          makeTrustAnswer({ name, packageType: "library", trustLevel: 2, verdict: "listed" })
        ),
      ]);
      // At level 2 every dependency meets the threshold, so the footer is the
      // only place that names the libraries. At 3 the listed libraries are
      // below it, and the Summary names each one.
      const output = formatBatchResults(response, 2);

      expect(output).toContain("my-mcp");
      expect(outOfScopeLine(output).trim()).toBe(
        "react, vue, express, lodash, chalk, axios + 2 more"
      );
      expect(output).not.toContain("moment");
      expect(output).not.toContain("underscore");
    });

    it("names a blocked library in the Summary, since audit exits 2 for it", () => {
      // A library gets no row in the trust table, but a library the registry
      // blocks is below --min-trust, which makes audit and batch exit 2 (and
      // check exits 2 for it). The text says why instead of saying that the
      // AI package meets the level.
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3, verdict: "safe" }),
        makeTrustAnswer({ name: "bad-lib", packageType: "library", trustLevel: 0, verdict: "blocked" }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("Audit failed: 1 dependency is below minimum trust level 3: bad-lib");
      expect(output).not.toContain("meets minimum trust level");
    });

    it("groups unclassified packages into an Unclassified section", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server" }),
        makeTrustAnswer({ name: "novel-random-pkg", found: false, packageType: undefined }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("1 unclassified");
      expect(output).toContain("Unclassified");
      expect(output).toContain("novel-random-pkg");
    });

    it("classifies @types/* as out of scope via name allowlist even without packageType", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server" }),
        makeTrustAnswer({ name: "@types/node", found: false, packageType: undefined }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("1 library out of scope");
      expect(output).toContain("@types/node");
      // @types/node should appear in the Out of scope section, not Unclassified
      expect(output).not.toContain("unclassified");
    });

    // audit exits 2 for every dependency the registry does not have, so the
    // text names each one, whatever section its tier puts it in.
    describe("names every dependency the registry does not have", () => {
      const foundLibraries = [
        "express", "pg", "redis", "jsonwebtoken", "axios", "cors",
        "dotenv", "fs", "path", "nodemon", "morgan",
      ].map((name) =>
        makeTrustAnswer({ name, packageType: "library", trustLevel: 2, verdict: "listed" })
      );

      function plain(output: string): string[] {
        return output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      }

      it("lists an unclassified name next to libraries when no AI package is present", () => {
        const response = makeBatchResponse([
          ...foundLibraries.slice(0, 7),
          makeTrustAnswer({ name: "child_process", found: false, packageType: undefined }),
          ...foundLibraries.slice(7),
        ]);
        const lines = plain(formatBatchResults(response, 2));

        expect(lines).toContain("  No AI packages found in 12 dependencies");
        const header = lines.findIndex((l) => l.includes("Unclassified"));
        expect(header).toBeGreaterThan(-1);
        expect(lines.slice(header + 1)).toContain("  │ child_process");
        expect(header).toBeLessThan(lines.findIndex((l) => l.includes("Next Steps")));
      });

      it("names a not-found library-tier name past the out-of-scope preview", () => {
        const response = makeBatchResponse([
          ...foundLibraries.slice(0, 8),
          makeTrustAnswer({ name: "@types/node", found: false, packageType: undefined }),
        ]);
        const lines = plain(formatBatchResults(response, 2));

        expect(lines).toContain("  Not found in registry: @types/node");
      });

      it("names a not-found library-tier name in the mixed-batch footer", () => {
        const response = makeBatchResponse([
          makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3 }),
          ...foundLibraries.slice(0, 8),
          makeTrustAnswer({ name: "@types/node", found: false, packageType: undefined }),
          makeTrustAnswer({ name: "@types/react", found: false, packageType: undefined }),
        ]);
        const lines = plain(formatBatchResults(response, 2));

        expect(lines).toContain("  Not found in registry: @types/node, @types/react");
      });

      it("lists every unclassified name, past six", () => {
        const unknownNames = Array.from({ length: 8 }, (_, i) => `zz-unknown-pkg-${i}`);
        const response = makeBatchResponse([
          makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3 }),
          ...unknownNames.map((name) =>
            makeTrustAnswer({ name, found: false, packageType: undefined })
          ),
        ]);
        const lines = plain(formatBatchResults(response, 2));

        for (const name of unknownNames) {
          expect(lines).toContain(`  │ ${name}`);
        }
        expect(lines.join("\n")).not.toContain("+ 2 more");
      });
    });

    it("shows a package scanned by --scan-missing in the trust table with its verdict", () => {
      // audit --scan-missing marks each locally scanned package found with
      // scanStatus "local" but no packageType, so the classifier alone
      // cannot place it. The user asked for the scan; show its result.
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "novel-random-pkg",
          packageType: undefined,
          scanStatus: "local",
          trustLevel: 3,
          trustScore: 0.85,
          verdict: "safe",
        }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("1 AI package audited");
      expect(output).not.toContain("unclassified");
      expect(output).not.toContain("Unclassified");
      const row = output.split("\n").find((l) => l.includes("novel-random-pkg"));
      expect(row).toBeDefined();
      expect(row).toContain("SAFE");
      expect(row).toContain("Scanned");
      expect(row).toContain("85");
      expect(row).toContain("local");
      expect(output).toContain("The AI package meets minimum trust level 3");
    });

    it("keeps a locally scanned package named like a library in the trust table", () => {
      // Every package the registry has not seen is scanned, including names
      // the library allowlist matches, so a squat's result must stay visible.
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server" }),
        makeTrustAnswer({
          name: "@types/squat-pkg",
          packageType: undefined,
          scanStatus: "local",
          trustLevel: 1,
          trustScore: 0.2,
          verdict: "warning",
        }),
      ]);
      const output = formatBatchResults(response, 3);

      expect(output).toContain("2 AI packages audited");
      expect(output).not.toContain("out of scope");
      expect(output).toContain("1 package(s) below minimum trust level 3");
      const row = output.split("\n").find((l) => l.includes("@types/squat-pkg") && l.includes("local"));
      expect(row).toBeDefined();
      expect(row).toContain("WARNING");
    });
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

  // audit and batch exit 2 when a dependency is not in the registry or is
  // below --min-trust. The Summary says so, names each one and gives the
  // command to run next, before the other sections.
  describe("the Summary of a batch that exits 2", () => {
    function plain(output: string): string[] {
      return output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    }

    const aiPackage = makeTrustAnswer({ name: "my-mcp", packageType: "mcp_server", trustLevel: 3 });
    const unknownMissing = makeTrustAnswer({
      name: "novel-random-pkg",
      found: false,
      packageType: undefined,
    });

    it("says the audit failed and names an unclassified name the registry does not have", () => {
      const lines = plain(formatBatchResults(makeBatchResponse([aiPackage, unknownMissing]), 2));

      expect(lines.find((l) => l.includes("Audit failed"))).toBe(
        "  Audit failed: 1 dependency is not in the registry and was not scanned: novel-random-pkg"
      );
      expect(lines.join("\n")).not.toContain("meets minimum trust level");
    });

    it("gives audit's --scan-missing command for the file it read", () => {
      const lines = plain(
        formatBatchResults(makeBatchResponse([aiPackage, unknownMissing]), 2, { file: "package.json" })
      );

      expect(lines).toContain("  Next: ai-trust audit package.json --scan-missing");
    });

    it("names every missing dependency of the new-user test's package.json, before the sections", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({
          name: "@modelcontextprotocol/server-filesystem",
          packageType: "mcp_server",
          trustLevel: 3,
        }),
        makeTrustAnswer({ name: "left-pad", packageType: "library", trustLevel: 2, verdict: "listed" }),
        makeTrustAnswer({ name: "@anthropic-ai/claude-code", found: false, packageType: undefined }),
        makeTrustAnswer({ name: "nonexistent-mcp-xyz-999", found: false, packageType: undefined }),
      ]);
      const lines = plain(formatBatchResults(response, 2, { file: "package.json" }));

      const summary = lines.findIndex((l) => l.includes("── Summary"));
      expect(summary).toBeGreaterThan(-1);
      expect(lines.slice(summary + 1, summary + 3)).toEqual([
        "  Audit failed: 2 dependencies are not in the registry and were not scanned: @anthropic-ai/claude-code, nonexistent-mcp-xyz-999",
        "  Next: ai-trust audit package.json --scan-missing",
      ]);
      expect(summary).toBeLessThan(lines.findIndex((l) => l.includes("Out of scope (libraries)")));
      expect(summary).toBeLessThan(lines.findIndex((l) => l.includes("── Unclassified")));
      expect(lines.join("\n")).not.toContain("meets minimum trust level");
    });

    it("names a dependency below the minimum trust level after the missing ones", () => {
      const response = makeBatchResponse([
        aiPackage,
        makeTrustAnswer({ name: "missing-mcp", found: false }),
        makeTrustAnswer({ name: "risky-mcp", trustLevel: 1, verdict: "warning" }),
      ]);
      const lines = plain(formatBatchResults(response, 2, { file: "package.json" }));

      expect(lines).toContain(
        "  Audit failed: 1 dependency is not in the registry and was not scanned: missing-mcp; 1 below minimum trust level 2: risky-mcp"
      );
      expect(lines).toContain("  Next: ai-trust audit package.json --scan-missing");
    });

    it("gives the check command for the first package below the level when none is missing", () => {
      const response = makeBatchResponse([
        aiPackage,
        makeTrustAnswer({ name: "risky-mcp", trustLevel: 1, verdict: "warning" }),
        makeTrustAnswer({ name: "other-risky-mcp", trustLevel: 0, verdict: "blocked" }),
      ]);
      const lines = plain(formatBatchResults(response, 2, { file: "package.json" }));

      expect(lines).toContain(
        "  Audit failed: 2 dependencies are below minimum trust level 2: risky-mcp, other-risky-mcp"
      );
      expect(lines).toContain("  Next: ai-trust check risky-mcp");
      expect(lines.join("\n")).not.toContain("meets minimum trust level");
    });

    it("checks a requirements.txt dependency as pip:<name>", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "risky-mcp", trustLevel: 1, verdict: "warning" }),
      ]);
      const lines = plain(
        formatBatchResults(response, 2, { file: "requirements.txt", ecosystem: "pypi" })
      );

      expect(lines).toContain("  Next: ai-trust check pip:risky-mcp");
    });

    it("gives batch, which reads no file, the check command for the first missing name", () => {
      const response = makeBatchResponse([
        aiPackage,
        unknownMissing,
        makeTrustAnswer({ name: "second-missing", found: false, packageType: undefined }),
      ]);
      const lines = plain(formatBatchResults(response, 2));

      expect(lines).toContain("  Next: ai-trust check novel-random-pkg");
      expect(lines.join("\n")).not.toContain("Next: ai-trust audit");
    });

    it("quotes a file name and a registry name that the shell would split", () => {
      const spaced = plain(
        formatBatchResults(makeBatchResponse([aiPackage, unknownMissing]), 2, {
          file: "my project/package.json",
        })
      );
      expect(spaced).toContain("  Next: ai-trust audit 'my project/package.json' --scan-missing");

      const shellName = plain(
        formatBatchResults(
          makeBatchResponse([
            makeTrustAnswer({ name: "shell-lib; echo injected", found: false, packageType: undefined }),
          ]),
          2
        )
      );
      expect(shellName).toContain("  Next: ai-trust check 'shell-lib; echo injected'");
    });

    it("says the audit failed before the library list when no AI package is present", () => {
      const response = makeBatchResponse([
        makeTrustAnswer({ name: "express", packageType: "library", trustLevel: 2, verdict: "listed" }),
        makeTrustAnswer({ name: "child_process", found: false, packageType: undefined }),
      ]);
      const lines = plain(formatBatchResults(response, 2, { file: "package.json" }));

      const failed = lines.indexOf(
        "  Audit failed: 1 dependency is not in the registry and was not scanned: child_process"
      );
      expect(failed).toBeGreaterThan(-1);
      expect(lines[failed + 1]).toBe("  Next: ai-trust audit package.json --scan-missing");
      expect(failed).toBeLessThan(lines.findIndex((l) => l.includes("Out of scope (libraries)")));
    });

    it("says the audit failed before the list when every name is unclassified", () => {
      const response = makeBatchResponse([
        unknownMissing,
        makeTrustAnswer({ name: "second-missing", found: false, packageType: undefined }),
      ]);
      const lines = plain(formatBatchResults(response, 2, { file: "package.json" }));

      const failed = lines.indexOf(
        "  Audit failed: 2 dependencies are not in the registry and were not scanned: novel-random-pkg, second-missing"
      );
      expect(failed).toBeGreaterThan(-1);
      expect(lines[failed + 1]).toBe("  Next: ai-trust audit package.json --scan-missing");
      expect(failed).toBeLessThan(lines.findIndex((l) => l.includes("Unclassified packages")));
    });

    it("prints the meets line and no failure when every dependency passes", () => {
      const response = makeBatchResponse([
        aiPackage,
        makeTrustAnswer({ name: "left-pad", packageType: "library", trustLevel: 2, verdict: "listed" }),
      ]);
      const output = formatBatchResults(response, 2, { file: "package.json" });

      expect(output).toContain("The AI package meets minimum trust level 2.");
      expect(output).not.toContain("Audit failed");
      expect(output).not.toContain("Next: ai-trust");
    });
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

  // A downloaded package scored 100/100 and the same files under --scan-path
  // 88/100, with nothing saying why (#230).
  it("names under the score the failed checks a downloaded package's score left out", () => {
    const result = makeScanResult({
      notCounted: ["GIT-001", "DEP-001", "SANDBOX-001"],
      scan: { score: 100, maxScore: 100, findings: [], projectType: "mcp", timestamp: "2026-10-18T00:00:00Z", checksEvaluated: 50 },
      trustScore: 1,
    });
    const lines = formatScanResult(result, { remote: true }).split("\n");
    const security = lines.findIndex((l) => l.startsWith("  Security  "));

    expect(lines[security + 1]).toBe(
      "            Not counted: GIT-001, DEP-001, SANDBOX-001 (local-setup checks a downloaded package is not scored on; --scan-path counts them)",
    );
  });

  it("counts the left-out checks past five", () => {
    const result = makeScanResult({
      notCounted: ["GIT-001", "GIT-002", "ENV-001", "PERM-001", "LOG-001", "DEP-001", "SANDBOX-001"],
      scan: { score: 100, maxScore: 100, findings: [], projectType: "mcp", timestamp: "2026-10-18T00:00:00Z", checksEvaluated: 50 },
    });

    expect(formatScanResult(result, { remote: true })).toContain(
      "Not counted: GIT-001, GIT-002, ENV-001, PERM-001, LOG-001 +2 more (",
    );
  });

  it("prints no not-counted line when the scan left nothing out", () => {
    const output = formatScanResult(
      makeScanResult({ scan: { score: 100, maxScore: 100, findings: [], projectType: "mcp", timestamp: "2026-10-18T00:00:00Z", checksEvaluated: 50 } }),
      { remote: true },
    );

    expect(output).not.toContain("Not counted");
  });

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

  it("suppresses the score and says 'not scored' when no analyzable surfaces (0 checks)", () => {
    const result = makeScanResult({
      trustScore: 1,
      scan: {
        score: 100,
        maxScore: 100,
        checksEvaluated: 0,
        findings: [],
        projectType: "unknown",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const output = formatScanResult(result);
    expect(output).toContain("not scored");
    expect(output).toContain("No analyzable surfaces");
    // A vacuous 100/100 must NOT appear — it would read as a clean bill of health.
    expect(output).not.toContain("100/100");
    expect(output).not.toContain("looks safe to use");
  });

  describe("a scan that read 0 files", () => {
    // What the scanner returns for an empty directory: two absent-file
    // findings and a score, from 0 files read.
    function emptyDirResult(filesExamined: number): ScanResult {
      return makeScanResult({
        packageName: "x",
        trustScore: 0.93,
        trustLevel: 3,
        verdict: "safe",
        scan: {
          score: 93,
          maxScore: 100,
          checksEvaluated: 22,
          filesExamined,
          findings: [
            {
              checkId: "GIT-001",
              name: "Missing .gitignore",
              description: "",
              category: "git hygiene",
              severity: "low",
              passed: false,
              message: "Create .gitignore to protect sensitive files",
              file: ".gitignore",
            },
            {
              checkId: "DEP-001",
              name: "Dependency Lock File",
              description: "",
              category: "supply-chain",
              severity: "medium",
              passed: false,
              message: "No lock file found - dependency versions may vary between installs",
              file: "package-lock.json",
            },
          ],
          projectType: "library",
          timestamp: "2026-10-16T00:00:00Z",
        },
      });
    }

    it("says there was nothing to scan, with no score, level, verdict or findings", () => {
      const output = formatScanResult(emptyDirResult(0), { remote: false, scanPath: "/tmp/fx/empty" });

      expect(output).toContain("Nothing to scan in /tmp/fx/empty: 0 files read.");
      expect(output).not.toContain("/100");
      expect(output).not.toMatch(/looks safe/i);
      expect(output).not.toContain("Level");
      expect(output).not.toContain("Scanned (3/4)");
      expect(output).not.toContain("Dependency Lock File");
      expect(output).not.toContain("Missing .gitignore");
      expect(output).not.toContain("package-lock.json");
      expect(output).not.toContain("Findings");
    });

    it("gives a command that lists the directory and the fix", () => {
      const output = formatScanResult(emptyDirResult(0), { remote: false, scanPath: "/tmp/fx/empty" });

      expect(output).toContain("Verify:  ls -A /tmp/fx/empty");
      expect(output).toContain("Fix:     pass --scan-path a directory that holds the files to scan");
    });

    it("quotes a directory with shell syntax in the Verify command and prints it without control characters", () => {
      const output = formatScanResult(emptyDirResult(0), {
        remote: false,
        scanPath: "/tmp/my dir\u001b[31m;rm",
      });

      expect(output).toContain("Nothing to scan in /tmp/my dir[31m;rm: 0 files read.");
      expect(output).toContain("Verify:  ls -A '/tmp/my dir[31m;rm'");
      expect(output).not.toContain("\u001b");
    });

    it("names the package when no directory is given", () => {
      const output = formatScanResult(emptyDirResult(0), { remote: true });

      expect(output).toContain("Nothing to scan in x: 0 files read.");
      expect(output).not.toContain("/100");
      expect(output).not.toContain("ls -A");
    });

    it("keeps the score when the scanner read files", () => {
      const output = formatScanResult(emptyDirResult(12), { remote: false, scanPath: "/tmp/project" });

      expect(output).toContain("93/100");
      expect(output).not.toContain("Nothing to scan");
    });

    it("keeps the score when the scanner did not report a count", () => {
      const result = emptyDirResult(0);
      delete result.scan.filesExamined;
      const output = formatScanResult(result, { remote: false, scanPath: "/tmp/project" });

      expect(output).toContain("93/100");
      expect(output).not.toContain("Nothing to scan");
    });

    it("keeps the score and the findings when the scanner found files it could not read", () => {
      // A directory holding one `.env` the scanner cannot read: 0 files read,
      // one unreadable input, and findings that name the file and its fix.
      const result = emptyDirResult(0);
      result.scan.unreadableInputs = 1;
      result.scan.score = 69;
      result.trustScore = 0.69;
      result.verdict = "warning";
      result.scan.findings.push(
        {
          checkId: "GIT-003",
          name: ".env Not Ignored",
          description: "",
          category: "git hygiene",
          severity: "high",
          passed: false,
          message: ".env is not in .gitignore",
          file: ".env",
        },
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
      );
      const output = formatScanResult(result, { remote: false, scanPath: "/tmp/fx/unreadable" });

      expect(output).toContain("69/100");
      expect(output).toContain(".env Not Ignored");
      expect(output).toContain("Input Discovered But Not Read");
      expect(output).toContain("chmod u+r .env");
      expect(output).not.toContain("Nothing to scan");
      expect(output).not.toContain("pass --scan-path a directory that holds the files to scan");
    });
  });

  describe("Verify lines and files that are not in the scanned directory (--scan-path)", () => {
    // What the scanner reports for a project with no Dockerfile: SANDBOX-001
    // names the file its fix would create, with no line and no fix, beside a
    // finding on line 12 of a file that is there.
    function treeResult(): ScanResult {
      return makeScanResult({
        packageName: "my-agent",
        trustScore: 0.88,
        trustLevel: 2,
        verdict: "safe",
        scan: {
          score: 88,
          maxScore: 100,
          checksEvaluated: 85,
          filesExamined: 2,
          findings: [
            {
              checkId: "SANDBOX-001",
              name: "Container Isolation",
              description: "",
              category: "sandboxing",
              severity: "medium",
              passed: false,
              message: "Consider running in Docker containers for isolation",
              file: "Dockerfile",
              attackClass: "SANDBOX-ESCAPE",
            },
            {
              checkId: "CODE-001",
              name: "Dynamic Code Execution",
              description: "",
              category: "code",
              severity: "low",
              passed: false,
              message: "eval() on request input",
              file: "src/index.js",
              line: 12,
              fix: "Parse the input instead of evaluating it",
            },
          ],
          projectType: "api",
          timestamp: "2026-10-18T00:00:00Z",
        },
      });
    }
    const absentFiles = new Set(["Dockerfile"]);

    /** The lines of the finding block whose header names `name`. */
    function findingBlock(output: string, name: string): string {
      const blocks = output.split("\n\n").filter((b) => b.includes("│"));
      const block = blocks.find((b) => b.split("\n")[0].endsWith(`  ${name}`));
      if (!block) throw new Error(`no finding block for ${name}`);
      return block;
    }

    it("prints the command that shows the line under a finding with a file and a line", () => {
      const output = formatScanResult(treeResult(), {
        remote: false,
        scanPath: "/tmp/fx/tree",
        absentFiles,
      });

      expect(findingBlock(output, "Dynamic Code Execution").split("\n")).toEqual([
        "  │ LOW  Dynamic Code Execution",
        "  │ src/index.js:12",
        "  │ eval() on request input",
        "  │ Verify: sed -n '12p' /tmp/fx/tree/src/index.js",
        "  │ Fix: Parse the input instead of evaluating it",
      ]);
    });

    it("says a file that is not in the directory is not present, gives it no Verify, and says the scanner supplied no fix", () => {
      const output = formatScanResult(treeResult(), {
        remote: false,
        scanPath: "/tmp/fx/tree",
        absentFiles,
      });

      expect(findingBlock(output, "Container Isolation").split("\n")).toEqual([
        "  │ MEDIUM  Container Isolation",
        "  │ Dockerfile (not present)",
        "  │ Consider running in Docker containers for isolation",
        "  │ Fix: none supplied by the scanner for SANDBOX-001; background: npx hackmyagent explain SANDBOX-001",
        "  │ Attack: SANDBOX-ESCAPE",
      ]);
      expect(output).not.toContain("in Dockerfile");
      expect(output).toContain("Looks safe to use. Container Isolation (no Dockerfile) + 1 more.");
      expect(output.match(/Verify:/g)).toHaveLength(1);
    });

    it("keeps the line of a finding whose file is not present, and gives it no Verify", () => {
      const result = treeResult();
      result.scan.findings[1].file = "src/removed.js";
      const output = formatScanResult(result, {
        remote: false,
        scanPath: "/tmp/fx/tree",
        absentFiles: new Set(["Dockerfile", "src/removed.js"]),
      });

      expect(output).toContain("│ src/removed.js:12 (not present)\n");
      expect(output).not.toContain("Verify:");
    });

    it("quotes a directory with shell syntax in the Verify command, and makes one that starts with - an operand", () => {
      const spaced = formatScanResult(treeResult(), {
        remote: false,
        scanPath: "/tmp/my dir;rm",
        absentFiles,
      });
      expect(spaced).toContain("│ Verify: sed -n '12p' '/tmp/my dir;rm/src/index.js'\n");

      const dashed = formatScanResult(treeResult(), { remote: false, scanPath: "-tree", absentFiles });
      expect(dashed).toContain("│ Verify: sed -n '12p' ./-tree/src/index.js\n");
    });

    it("prints no Verify for a path with a control or format character, which the line cannot show as it is", () => {
      // An ESC sequence, and a right-to-left override (U+202E).
      const rlo = String.fromCodePoint(0x202e);
      for (const file of ["src/in\u001b[2Kdex.js", `src/in${rlo}dex.js`]) {
        const result = treeResult();
        result.scan.findings[1].file = file;
        const output = formatScanResult(result, { remote: false, scanPath: "/tmp/fx/tree", absentFiles });

        expect(output).not.toContain("Verify:");
        expect(output).not.toContain("\u001b");
      }
    });

    it("leaves a downloaded package's findings as the scanner reported them: no Verify, no presence label, no added Fix line", () => {
      const output = formatScanResult(treeResult(), { remote: true });

      expect(findingBlock(output, "Container Isolation").split("\n")).toEqual([
        "  │ MEDIUM  Container Isolation",
        "  │ Dockerfile",
        "  │ Consider running in Docker containers for isolation",
        "  │ Attack: SANDBOX-ESCAPE",
      ]);
      expect(output).not.toContain("Verify:");
      expect(output).toContain("Container Isolation in Dockerfile + 1 more.");
    });
  });

  it("remote verdict (downloaded package): medium-only findings avoid `secure --fix`", () => {
    // cli-ui 0.5.2 surface.remote: a downloaded third-party package's verdict
    // guidance must be review / choose-a-vetted-version, never `secure --fix`
    // on code the user does not own.
    const result = makeScanResult({
      scan: {
        score: 70,
        maxScore: 100,
        checksEvaluated: 30,
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
        projectType: "library",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const remoteOutput = formatScanResult(result, { remote: true });
    expect(remoteOutput).toContain("downloaded package");
    expect(remoteOutput).not.toContain("secure --fix");
    expect(remoteOutput).toMatch(/review|depend/i);

    // Local default keeps the `secure --fix` remediation guidance, named as
    // the hackmyagent command (ai-trust has no `secure` command).
    const localOutput = formatScanResult(result, { remote: false });
    expect(localOutput).toContain("local scan");
    expect(localOutput).toContain("npx hackmyagent secure --fix");
    expect(localOutput).not.toMatch(/(?<!npx hackmyagent )secure --fix/);
  });

  it("remote verdict (downloaded package): high/critical findings still avoid `secure --fix` in Next Steps", () => {
    // Regression guard: the hand-rolled Next Steps block emits an
    // `Auto-fix: secure --fix` line for critical/high findings. That line must
    // be suppressed for a downloaded package, or the output contradicts the
    // remote-aware Verdict line (header says "downloaded package", Verdict
    // says "review before depending", but Next Steps says "secure --fix").
    const result = makeScanResult({
      verdict: "blocked",
      scan: {
        score: 40,
        maxScore: 100,
        checksEvaluated: 30,
        findings: [
          {
            checkId: "CRED-001",
            name: "Hardcoded Credentials",
            description: "Found hardcoded credentials",
            category: "secrets",
            severity: "high",
            passed: false,
            message: "API key found in source code",
          },
        ],
        projectType: "library",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const remoteOutput = formatScanResult(result, { remote: true });
    expect(remoteOutput).toContain("downloaded package");
    expect(remoteOutput).not.toContain("secure --fix");
    // The remote Next Steps action points at version selection, not auto-fix.
    expect(remoteOutput).toMatch(/vetted version|alternative/i);

    // Local scan with the same high finding DOES offer `secure --fix`.
    const localOutput = formatScanResult(result, { remote: false });
    expect(localOutput).toContain("secure --fix");
  });

  it("defaults to local verdict when no options are passed", () => {
    const result = makeScanResult({
      scan: {
        score: 70,
        maxScore: 100,
        checksEvaluated: 30,
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
        projectType: "library",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });
    const output = formatScanResult(result);
    expect(output).toContain("local scan");
    expect(output).toContain("npx hackmyagent secure --fix");
    expect(output).not.toMatch(/(?<!npx hackmyagent )secure --fix/);
  });

  it("gives the finding's Fix line the same `npx hackmyagent` form as the Verdict", () => {
    // The scanner's own fix text names its CLI bare (`hackmyagent secure
    // --fix`); the Verdict names the npx form. One form in both places.
    const result = makeScanResult({
      scan: {
        score: 93,
        maxScore: 100,
        checksEvaluated: 26,
        findings: [
          {
            checkId: "GIT-001",
            name: "Missing .gitignore",
            description: "No .gitignore file",
            category: "git",
            severity: "low",
            passed: false,
            message: "Create .gitignore to protect sensitive files",
            fix: "hackmyagent secure --fix",
          },
          {
            checkId: "GIT-002",
            name: "Incomplete .gitignore",
            description: "Patterns missing",
            category: "git",
            severity: "low",
            passed: false,
            message: "Add the missing patterns",
            fix: "Run npx hackmyagent secure --fix, or add the patterns by hand",
          },
        ],
        projectType: "library",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });
    const output = formatScanResult(result).replace(/\x1b\[[0-9;]*m/g, "");
    expect(output).toContain("Minor findings — run `npx hackmyagent secure --fix`");
    expect(output).toContain("Fix: npx hackmyagent secure --fix\n");
    expect(output).toContain("Fix: Run npx hackmyagent secure --fix, or add the patterns by hand");
    expect(output).not.toMatch(/(?<!npx )hackmyagent secure --fix/);
  });

  it("prints a Fix line that names opena2a or secretless-ai in the npx form of its package", () => {
    // The scanner's fix text names each OpenA2A CLI by its command
    // (`opena2a protect .`). A global install of ai-trust puts none of them on
    // PATH, and npm has no package named opena2a: the package is opena2a-cli.
    const finding = (checkId: string, fix: string) => ({
      checkId,
      name: checkId,
      description: checkId,
      category: "secrets",
      severity: "high" as const,
      passed: false,
      message: checkId,
      fix,
    });
    const result = makeScanResult({
      scan: {
        score: 40,
        maxScore: 100,
        checksEvaluated: 30,
        findings: [
          finding(
            "CRED-001",
            "opena2a protect . — migrates hardcoded secrets into the Secretless vault (local, keychain, 1Password, or HashiCorp Vault).",
          ),
          finding("CRED-002", "secretless-ai scan ."),
          finding("CRED-003", "hackmyagent secure --fix"),
          finding(
            "SOUL-001",
            "Add a SOUL.md or system prompt with safety boundaries. Run: hackmyagent scan-soul to generate one.",
          ),
        ],
        projectType: "library",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });
    const output = formatScanResult(result).replace(/\x1b\[[0-9;]*m/g, "");
    expect(output).toContain(
      "Fix: npx opena2a-cli protect . — migrates hardcoded secrets into the Secretless vault (local, keychain, 1Password, or HashiCorp Vault).\n",
    );
    expect(output).toContain("Fix: npx secretless-ai scan .\n");
    expect(output).toContain("Fix: npx hackmyagent secure --fix\n");
    expect(output).toContain("Run: npx hackmyagent scan-soul to generate one.\n");
    expect(output).not.toMatch(/(?<!npx )(?:opena2a|secretless-ai) (?:protect|scan)\b/);
  });

  it("still shows the score on a clean scan that DID run checks (suppression must not over-fire)", () => {
    // Guards against a regression that drops the `checksEvaluated === 0`
    // conjunct and suppresses any 0-finding scan — a fully-measured clean
    // package (many checks, no findings) must keep its earned score.
    const result = makeScanResult({
      trustScore: 1,
      scan: {
        score: 100,
        maxScore: 100,
        checksEvaluated: 50,
        findings: [],
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const output = formatScanResult(result);
    expect(output).toContain("100/100");
    expect(output).not.toContain("not scored");
    expect(output).not.toContain("No analyzable surfaces");
  });

  it("shows the executed-check count (not the findings count) on the Checks line", () => {
    const result = makeScanResult({
      scan: {
        score: 95,
        maxScore: 100,
        checksEvaluated: 42,
        findings: [
          {
            checkId: "SEC-001",
            name: "Missing CSP",
            description: "No CSP header",
            category: "headers",
            severity: "low",
            passed: false,
            message: "Content-Security-Policy header missing",
          },
        ],
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });

    const output = formatScanResult(result);
    // 42 executed checks, not "1 static" (the single finding).
    expect(output).toContain("42 static");
    expect(output).not.toContain("1 static");
  });

  describe("semantic count on the Checks line", () => {
    const checksLine = (output: string): string | undefined =>
      output.split("\n").find((l) => l.trim().startsWith("Checks"));

    // Counts from the scanner on test/dvaa: 127 executed records, 34 of them
    // AST-*/SEM-*, and 12 artifacts compiled by the semantic layer.
    const semanticFinding = {
      checkId: "SEM-CRED-001",
      name: "Credential in agent instructions",
      description: "Credential in agent instructions",
      category: "credentials",
      severity: "critical" as const,
      passed: false,
      message: "Credential in agent instructions",
    };

    it("prints the scanner's semantic count and leaves AST-*/SEM-* records out of the static count", () => {
      const result = makeScanResult({
        scan: {
          score: 4,
          maxScore: 100,
          checksEvaluated: 127,
          staticChecksEvaluated: 93,
          semanticCount: 12,
          findings: [semanticFinding],
          projectType: "api",
          timestamp: "2026-10-16T00:00:00Z",
        },
      });

      const line = checksLine(formatScanResult(result));
      expect(line).toBe("  Checks      93 static · 12 semantic (NanoMind AST) · 0 skipped");
    });

    it("says the semantic layer did not run when the scan used --no-deep", () => {
      const result = makeScanResult({
        scan: {
          score: 13,
          maxScore: 100,
          checksEvaluated: 109,
          staticChecksEvaluated: 93,
          semanticCount: 0,
          staticOnly: true,
          findings: [semanticFinding],
          projectType: "api",
          timestamp: "2026-10-16T00:00:00Z",
        },
      });

      const line = checksLine(formatScanResult(result));
      expect(line).toBe("  Checks      93 static · 0 semantic (not run: --no-deep) · 0 skipped");
    });

    it("says the semantic count was not reported, never 0, when the scanner omits it", () => {
      const result = makeScanResult({
        scan: {
          score: 85,
          maxScore: 100,
          checksEvaluated: 40,
          findings: [],
          projectType: "node",
          timestamp: "2026-10-16T00:00:00Z",
        },
      });

      const line = checksLine(formatScanResult(result));
      expect(line).toBe("  Checks      40 static · semantic not reported · 0 skipped");
    });
  });

  it("names pypi in the header of a downloaded pip:<name> package (#141)", () => {
    const header = (opts: Parameters<typeof formatScanResult>[1]) =>
      formatScanResult(makeScanResult(), opts)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")
        .find((l) => l.trim().length > 0);

    expect(header({ remote: true, ecosystem: "pypi" })).toBe("  test-pkg (pypi)  downloaded package");
    expect(header({ remote: true, ecosystem: "npm" })).toBe("  test-pkg  downloaded package");
    expect(header({ remote: true })).toBe("  test-pkg  downloaded package");
  });

  function scanWithFindings(findings: ScanResult["scan"]["findings"]): ScanResult {
    return makeScanResult({
      verdict: "warning",
      scan: {
        score: 60,
        maxScore: 100,
        checksEvaluated: 40,
        findings,
        projectType: "node",
        timestamp: "2026-03-15T00:00:00Z",
      },
    });
  }

  it("prints file:line under a finding that carries both", () => {
    const output = formatScanResult(
      scanWithFindings([
        {
          checkId: "CLAUDE-002",
          name: "Overly Permissive Permissions",
          description: "",
          category: "claude-code",
          severity: "high",
          passed: false,
          message: "Scope permissions to specific paths",
          file: ".claude/settings.json",
          line: 4,
        },
      ]),
    );
    const lines = output.split("\n");
    const header = lines.indexOf("  │ HIGH  Overly Permissive Permissions");
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1]).toBe("  │ .claude/settings.json:4");
  });

  it("prints the file alone under a finding with no line, and nothing for one with no file", () => {
    const output = formatScanResult(
      scanWithFindings([
        {
          checkId: "SEM-PERM-002",
          name: "Unrestricted Bash access",
          description: "",
          category: "permissions",
          severity: "high",
          passed: false,
          message: "Bash is allowed with no restriction",
          file: ".claude/settings.json",
        },
        {
          checkId: "SEC-001",
          name: "Missing CSP",
          description: "",
          category: "headers",
          severity: "medium",
          passed: false,
          message: "Content-Security-Policy header missing",
        },
      ]),
    );
    const lines = output.split("\n");
    const withFile = lines.indexOf("  │ HIGH  Unrestricted Bash access");
    expect(withFile).toBeGreaterThan(-1);
    expect(lines[withFile + 1]).toBe("  │ .claude/settings.json");
    const noFile = lines.indexOf("  │ MEDIUM  Missing CSP");
    expect(noFile).toBeGreaterThan(-1);
    expect(lines[noFile + 1]).toBe("  │ Content-Security-Policy header missing");
  });

  it("removes control characters from a scanned file path before printing it", () => {
    const output = formatScanResult(
      scanWithFindings([
        {
          checkId: "SKILL-001",
          name: "Unsigned skill",
          description: "",
          category: "skills",
          severity: "medium",
          passed: false,
          message: "Skill has no signature",
          file: "skills/a\u001b[2Jb.md",
          line: 2,
        },
      ]),
    );
    expect(output).not.toContain("\u001b");
    expect(output).toContain("skills/a[2Jb.md:2");
  });

  describe("findings past the first ten", () => {
    function twelveFindings(): ScanResult {
      return makeScanResult({
        verdict: "blocked",
        scan: {
          score: 20,
          maxScore: 100,
          checksEvaluated: 40,
          findings: Array.from({ length: 12 }, (_, i) => ({
            checkId: `TEST-${String(i + 1).padStart(3, "0")}`,
            name: `Finding number ${i + 1}`,
            description: `Description ${i + 1}`,
            category: "test",
            severity: "high",
            passed: false,
            message: `Message ${i + 1}`,
            fix: `Fix step ${i + 1}`,
          })),
          projectType: "node",
          timestamp: "2026-03-15T00:00:00Z",
        },
      });
    }

    beforeEach(() => {
      vi.stubEnv("AI_TRUST_CLI_PREFIX", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("cites the --all option under the truncation line", () => {
      const output = formatScanResult(twelveFindings(), {
        remote: false,
        rerunCommand: "ai-trust check dvaa --scan-path /tmp/fx/dvaa --no-deep",
      });

      expect(output).toContain(
        "+ 2 more findings (show all: ai-trust check dvaa --scan-path /tmp/fx/dvaa --no-deep --all)",
      );
      expect(output).toContain("Finding number 10");
      expect(output).not.toContain("Finding number 11");
    });

    it("cites check <name> --all when no command is given, through the CLI prefix", () => {
      expect(formatScanResult(twelveFindings())).toContain(
        "+ 2 more findings (show all: ai-trust check test-pkg --all)",
      );

      vi.stubEnv("AI_TRUST_CLI_PREFIX", "opena2a registry");
      expect(formatScanResult(twelveFindings())).toContain(
        "+ 2 more findings (show all: opena2a registry test-pkg --all)",
      );
    });

    it("prints every finding with its Fix when all is set", () => {
      const output = formatScanResult(twelveFindings(), { all: true });

      for (let i = 1; i <= 12; i++) {
        expect(output).toContain(`Finding number ${i}`);
        expect(output).toContain(`Fix step ${i}`);
      }
      expect(output).not.toContain("more findings");
    });
  });
});

describe("formatNotFound", () => {
  it("renders the shared cli-ui not-found header", () => {
    const output = formatNotFound({ pkg: "@anthropic/code-review", ecosystem: "npm" });
    expect(output).toContain("Package not found: @anthropic/code-review (npm)");
    expect(output).toContain("Next Steps");
  });

  it("suggests the default scan command, not the no-op --scan-if-missing (#98)", () => {
    const output = formatNotFound({ pkg: "mcp-server-xyz", ecosystem: "npm" });
    expect(output).toContain("Scan locally");
    expect(output).toContain("ai-trust check mcp-server-xyz");
    expect(output).not.toContain("--scan-if-missing");
  });

  it("keeps the pip: prefix in the scan command for a PyPI miss (#114)", () => {
    const output = formatNotFound({ pkg: "smolagents", ecosystem: "pypi" });
    expect(output).toContain("Package not found: smolagents (pypi)");
    expect(output).toContain("ai-trust check pip:smolagents");
    expect(output).not.toMatch(/ai-trust check smolagents/);
  });

  it("keeps the pip: prefix and the version for a versioned PyPI miss (#114)", () => {
    const output = formatNotFound({ pkg: "smolagents@1.0.0", ecosystem: "pypi" });
    expect(output).toContain("ai-trust check pip:smolagents@1.0.0");
  });

  it("includes did-you-mean suggestions when provided", () => {
    const output = formatNotFound({
      pkg: "code-revie",
      ecosystem: "npm",
      suggestions: ["code-review", "ai-code-review"],
    });
    expect(output).toContain("Did you mean?");
    expect(output).toContain("code-review");
    expect(output).toContain("ai-code-review");
  });

  it("surfaces the errorHint line when provided", () => {
    const output = formatNotFound({
      pkg: "anthropic/code-review",
      ecosystem: "npm",
      errorHint: "Looks like a git-style name.",
    });
    expect(output).toContain("Looks like a git-style name.");
  });
});

// The audit next step is printed only where `ai-trust audit <file>` can run:
// a package.json or requirements.txt in the current directory.
describe("Full project audit next step", () => {
  let dir: string;
  let cwdSpy: MockInstance<() => string>;

  function inDir(...files: string[]): void {
    for (const f of files) writeFileSync(join(dir, f), "");
  }

  function makeCleanScan(overrides: Partial<ScanResult> = {}): ScanResult {
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-trust-cta-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("after a registry answer", () => {
    it("is omitted when the directory holds no dependency file", () => {
      const output = formatCheckResult(makeTrustAnswer({ name: "some-pkg" }));
      expect(output).toContain("Fresh scan  ai-trust check some-pkg");
      expect(output).not.toContain("Full project audit");
      expect(output).not.toContain("ai-trust audit");
    });

    it("names package.json when it exists", () => {
      inDir("package.json");
      const output = formatCheckResult(makeTrustAnswer({ name: "some-pkg" }));
      expect(output).toContain("Full project audit  ai-trust audit package.json");
    });

    it("names requirements.txt when only it exists", () => {
      inDir("requirements.txt");
      const output = formatCheckResult(makeTrustAnswer({ name: "some-pkg" }));
      expect(output).toContain("Full project audit  ai-trust audit requirements.txt");
      expect(output).not.toContain("audit package.json");
    });

    it("names package.json when both exist", () => {
      inDir("package.json", "requirements.txt");
      const output = formatCheckResult(makeTrustAnswer({ name: "some-pkg" }));
      expect(output).toContain("ai-trust audit package.json");
      expect(output).not.toContain("audit requirements.txt");
    });
  });

  describe("in the not-found block", () => {
    it("is omitted when the directory holds no dependency file", () => {
      const output = formatNotFound({ pkg: "mcp-server-xyz", ecosystem: "npm" });
      expect(output).toContain("Scan locally  ai-trust check mcp-server-xyz");
      expect(output).not.toContain("ai-trust audit");
    });

    it("quotes a name with shell syntax in the Scan locally command (#218)", () => {
      const output = formatNotFound({ pkg: "shell-lib; echo injected", ecosystem: "npm" });
      expect(output).toContain("Scan locally  ai-trust check 'shell-lib; echo injected'");
      expect(output).not.toContain("ai-trust check shell-lib; echo injected");
    });

    it("names the file that exists", () => {
      inDir("requirements.txt");
      const output = formatNotFound({ pkg: "mcp-server-xyz", ecosystem: "npm" });
      expect(output).toContain("Full project audit  ai-trust audit requirements.txt");
    });

    // After a scan that could not download the package, the scan step would
    // repeat the command that just failed (#123).
    it("leaves out the scan step after a failed scan, with no empty Next Steps section", () => {
      const output = formatNotFound({
        pkg: "this-pkg-does-not-exist-zzz-918273",
        ecosystem: "npm",
        scanned: true,
      });
      expect(output).toContain("Package not found: this-pkg-does-not-exist-zzz-918273 (npm)");
      expect(output).not.toContain("Scan locally");
      expect(output).not.toContain("ai-trust check this-pkg-does-not-exist-zzz-918273");
      expect(output).not.toContain("Next Steps");
    });

    it("keeps the audit step after a failed scan when the directory holds a dependency file", () => {
      inDir("package.json");
      const output = formatNotFound({
        pkg: "this-pkg-does-not-exist-zzz-918273",
        ecosystem: "npm",
        scanned: true,
      });
      expect(output).toContain("Next Steps");
      expect(output).toContain("Full project audit  ai-trust audit package.json");
      expect(output).not.toContain("Scan locally");
    });
  });

  describe("after a scan", () => {
    it("is omitted, with no empty Next Steps section, for a clean scan in a directory with no dependency file", () => {
      const output = formatScanResult(makeCleanScan());
      expect(output).not.toContain("ai-trust audit");
      expect(output).not.toContain("Next Steps");
    });

    it("is omitted while the other next steps stay when the scan has findings", () => {
      const output = formatScanResult(makeCleanScan({ verdict: "warning" }));
      expect(output).toContain("Next Steps");
      expect(output).toContain("Remediate:");
      expect(output).not.toContain("ai-trust audit");
    });

    it("names the file that exists", () => {
      inDir("package.json");
      const output = formatScanResult(makeCleanScan());
      expect(output).toContain("Next Steps");
      expect(output).toContain("Full project audit: ai-trust audit package.json");
    });
  });
});

// translateDownloadError tests moved to @opena2a/check-core — see
// opena2a/packages/check-core/src/translate-error.test.ts. Both consumers
// (ai-trust + hackmyagent) now import the single implementation.

describe("formatJson control characters (#129)", () => {
  it("writes C0 controls, DEL and C1 controls as escapes that parse back unchanged", () => {
    let all = "";
    for (let code = 0; code <= 0x1f; code++) all += String.fromCharCode(code);
    for (let code = 0x7f; code <= 0x9f; code++) all += String.fromCharCode(code);
    const data = { name: `a${all}b`, nested: [`x\u009b31m`] };
    const json = formatJson(data);

    // Only the line feeds of the pretty-printed layout remain.
    expect(json.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(json).toContain('"x\\u009b31m"');
    expect(JSON.parse(json)).toEqual(data);
  });

  it("leaves text without control characters as JSON.stringify writes it", () => {
    const data = { name: "@scope/pkg", note: "café 日本語 · 79/100", score: 0.79 };
    expect(formatJson(data)).toBe(JSON.stringify(data, null, 2));
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
