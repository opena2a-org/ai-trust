/**
 * Tests for community contribution module.
 *
 * Verifies:
 *   - Legacy payload structure matches server-side schema (backward compat)
 *   - No PII (file paths, line numbers, descriptions, fix text) in payload
 *   - Contributor token is a 64-char hex SHA256
 *   - queueScanResult delegates to @opena2a/contribute with correct summary
 *   - flushQueue delegates to @opena2a/contribute
 *   - submitContribution queues each scan's summary when contribution is
 *     saved as on and sends it at once otherwise, flushes, sends each scan,
 *     and never throws
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
    // Contribution saved as on, unless a test says otherwise.
    isContributeEnabled: vi.fn().mockReturnValue(true),
    submitBatch: vi.fn().mockResolvedValue(true),
  };
});

// The registry's publish endpoint, as submitContribution's client reaches it.
const publishScanMock = vi.hoisted(() => vi.fn());
vi.mock("@opena2a/registry-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opena2a/registry-client")>()),
  RegistryClient: vi.fn().mockImplementation(function () {
    return { publishScan: publishScanMock };
  }),
}));

import {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  queueScanResult,
  flushQueue,
  sendScanPing,
  scanPingsSettled,
  type ContributionPayload,
} from "./contribute.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HmaFinding } from "../scanner/hma.js";
import type { ScanResult } from "../scanner/index.js";
import {
  contribute,
  getContributorToken,
  isContributeEnabled,
  queueEvent,
  submitBatch,
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

/** A scan of test-pkg that listed `findings`, with the scanner's score of 40. */
function scanOf(
  findings: HmaFinding[],
  scan: Partial<ScanResult["scan"]> = {},
  packageVersion?: string,
): ScanResult {
  return {
    packageName: "test-pkg",
    ...(packageVersion !== undefined ? { packageVersion } : {}),
    scan: {
      score: 40,
      maxScore: 100,
      findings,
      projectType: "library",
      timestamp: "2026-10-21T00:00:00Z",
      ...scan,
    },
    trustScore: 0.4,
    trustLevel: 1,
    verdict: "blocked",
  };
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
    queueScanResult("test-pkg", scanOf(makeSampleFindings()));

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
    queueScanResult("test-pkg", scanOf(makeSampleFindings()));

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

  it("passes the package version through when one is known", () => {
    queueScanResult("test-pkg", scanOf(makeSampleFindings(), {}, "0.9.1"), "pypi");

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args.packageVersion).toBe("0.9.1");
    expect(args.ecosystem).toBe("pypi");
  });

  it("calls scanResult for each invocation", () => {
    queueScanResult("pkg-a", scanOf(makeSampleFindings()));
    queueScanResult("pkg-b", scanOf([]));

    expect(contribute.scanResult).toHaveBeenCalledTimes(2);
    expect(vi.mocked(contribute.scanResult).mock.calls[0][0].packageName).toBe(
      "pkg-a"
    );
    expect(vi.mocked(contribute.scanResult).mock.calls[1][0].packageName).toBe(
      "pkg-b"
    );
  });

  // The scanner's findings list only the checks that failed: a score and
  // counts computed from that list read 0 for a scan the terminal and the
  // published scan score 100 (#123).
  it("sends the scanner's score, not a share of the listed findings", () => {
    queueScanResult("test-pkg", scanOf(makeSampleFindings(), { score: 40 }));

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args.score).toBe(40);
  });

  it("sends the score out of 100 when the scanner's maximum is another number", () => {
    queueScanResult("test-pkg", scanOf([], { score: 45, maxScore: 50, checksPassed: 9 }));

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args.score).toBe(90);
  });

  it("counts the passed checks from the scanner's report for a scan with no failures", () => {
    queueScanResult("empty-pkg", scanOf([], { score: 100, checksEvaluated: 35, checksPassed: 27 }));

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args).toMatchObject({
      totalChecks: 27,
      passed: 27,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      score: 100,
      verdict: "pass",
    });
  });

  it("adds the failures the scan counts to the passed checks for the total", () => {
    const failed = makeSampleFindings().filter((f) => !f.passed);
    queueScanResult("test-pkg", scanOf(failed, { score: 60, checksPassed: 20 }));

    const args = vi.mocked(contribute.scanResult).mock.calls[0][0];
    expect(args).toMatchObject({
      totalChecks: 22,
      passed: 20,
      critical: 1,
      high: 1,
      score: 60,
      verdict: "fail",
    });
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

describe("submitContribution", () => {
  beforeEach(() => {
    vi.mocked(contribute.scanResult).mockClear();
    vi.mocked(contribute.flush).mockClear();
    vi.mocked(submitBatch).mockClear();
    vi.mocked(queueEvent).mockClear();
    vi.mocked(isContributeEnabled).mockReturnValue(true);
    publishScanMock.mockReset();
  });

  function scan(name: string, version: string): { name: string; scanResult: ScanResult } {
    return {
      name,
      scanResult: {
        packageName: name,
        packageVersion: version,
        scan: {
          score: 80,
          maxScore: 100,
          findings: makeSampleFindings(),
          projectType: "mcp_server",
          timestamp: "2026-10-15T00:00:00Z",
        },
        trustScore: 0.8,
        trustLevel: 3,
        verdict: "warning",
      } as ScanResult,
    };
  }

  it("queues each scan's summary, flushes once, then sends each scan's per-check results", async () => {
    await submitContribution([scan("pkg-a", "1.0.0"), scan("pkg-b", "2.0.0")], "http://localhost:1", {
      ecosystem: "pypi",
      type: "mcp_server",
    });

    expect(vi.mocked(contribute.scanResult).mock.calls.map(([e]) => [e.packageName, e.packageVersion, e.ecosystem])).toEqual([
      ["pkg-a", "1.0.0", "pypi"],
      ["pkg-b", "2.0.0", "pypi"],
    ]);
    expect(contribute.flush).toHaveBeenCalledOnce();
    expect(contribute.flush).toHaveBeenCalledWith("http://localhost:1", undefined);
    expect(submitBatch).not.toHaveBeenCalled();
    expect(publishScanMock.mock.calls.map(([s]) => [s.name, s.version, s.ecosystem, s.type])).toEqual([
      ["pkg-a", "1.0.0", "pypi", "mcp_server"],
      ["pkg-b", "2.0.0", "pypi", "mcp_server"],
    ]);
  });

  // The contribute library queues a summary only when contribution is saved
  // as on, so a scan shared with --contribute alone sent none (#123).
  describe("when contribution is not saved as on", () => {
    beforeEach(() => {
      vi.mocked(isContributeEnabled).mockReturnValue(false);
    });

    it("sends each scan's summary at once, in one batch under the word anonymous, and queues none", async () => {
      await submitContribution([scan("pkg-a", "1.0.0"), scan("pkg-b", "2.0.0")], "http://localhost:1", {
        ecosystem: "pypi",
      });

      expect(contribute.scanResult).not.toHaveBeenCalled();
      expect(queueEvent).not.toHaveBeenCalled();
      expect(submitBatch).toHaveBeenCalledOnce();
      const [batch, url] = vi.mocked(submitBatch).mock.calls[0];
      expect(url).toBe("http://localhost:1");
      expect(batch.contributorToken).toBe("anonymous");
      expect(batch.events.map((e) => [e.type, e.tool, e.package])).toEqual([
        ["scan_result", "ai-trust", { name: "pkg-a", version: "1.0.0", ecosystem: "pypi" }],
        ["scan_result", "ai-trust", { name: "pkg-b", version: "2.0.0", ecosystem: "pypi" }],
      ]);
      expect(batch.events[0].scanSummary).toEqual({
        totalChecks: 3,
        passed: 1,
        critical: 1,
        high: 1,
        medium: 0,
        low: 0,
        score: 80,
        verdict: "fail",
        durationMs: 0,
      });
      // Summaries an earlier run queued still go, with the flush.
      expect(contribute.flush).toHaveBeenCalledOnce();
      expect(publishScanMock).toHaveBeenCalledTimes(2);
    });

    it("keeps no summary when the upload fails, and still publishes the scan", async () => {
      vi.mocked(submitBatch).mockResolvedValueOnce(false);

      await expect(
        submitContribution([scan("pkg-a", "1.0.0")], "http://localhost:1", { ecosystem: "npm" }),
      ).resolves.toBeUndefined();

      expect(submitBatch).toHaveBeenCalledOnce();
      expect(queueEvent).not.toHaveBeenCalled();
      expect(contribute.scanResult).not.toHaveBeenCalled();
      expect(publishScanMock).toHaveBeenCalledOnce();
    });
  });

  it("sends check IDs and results, never finding names, messages or file paths (#97)", async () => {
    await submitContribution([scan("pkg-a", "1.0.0")], "http://localhost:1", { ecosystem: "npm" });

    const wire = JSON.stringify(publishScanMock.mock.calls[0][0]);
    expect(wire).toContain("CRED-001");
    expect(wire).not.toContain("Hardcoded API key");
    expect(wire).not.toContain("API key sk-1234");
    expect(wire).not.toContain("src/config.ts");
  });

  it("resolves when the flush and the send both fail", async () => {
    vi.mocked(contribute.flush).mockRejectedValueOnce(new Error("offline"));
    publishScanMock.mockRejectedValue(new Error("offline"));

    await expect(
      submitContribution([scan("pkg-a", "1.0.0")], "http://localhost:1", { ecosystem: "npm" }),
    ).resolves.toBeUndefined();
    expect(publishScanMock).toHaveBeenCalledOnce();
  });

  // #129: the queued event carried verdict "pass" whatever the findings were.
  function queuedVerdict(findings: HmaFinding[]): string | undefined {
    vi.mocked(contribute.scanResult).mockClear();
    queueScanResult("test-pkg", scanOf(findings));
    return vi.mocked(contribute.scanResult).mock.calls[0][0].verdict;
  }

  function finding(severity: string, passed: boolean): HmaFinding {
    return {
      checkId: "CHECK-001",
      name: "check",
      description: "check",
      category: "test",
      severity,
      passed,
      message: "",
    } as HmaFinding;
  }

  it("queues verdict fail when a critical check failed", () => {
    expect(queuedVerdict(makeSampleFindings())).toBe("fail");
  });

  it("queues verdict warn when a high check failed and no critical one did", () => {
    expect(queuedVerdict([finding("high", false), finding("critical", true)])).toBe("warn");
  });

  it("queues verdict pass when no critical or high check failed", () => {
    expect(queuedVerdict([finding("medium", false), finding("high", true)])).toBe("pass");
    expect(queuedVerdict([])).toBe("pass");
  });
});

describe("scanPingsSettled (#129)", () => {
  // A registry that answers a scan ping only after ANSWER_DELAY_MS.
  const ANSWER_DELAY_MS = 400;
  let server: Server;
  let registryUrl: string;
  let received: Array<Record<string, unknown>>;
  let answered: number;

  beforeEach(async () => {
    received = [];
    answered = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ path: req.url, ...JSON.parse(body) });
        setTimeout(() => {
          answered++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, ANSWER_DELAY_MS);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  it("resolves at once when no ping was sent", async () => {
    const startedAt = Date.now();
    await scanPingsSettled();
    expect(Date.now() - startedAt).toBeLessThan(ANSWER_DELAY_MS);
  });

  it("resolves only after the registry has answered the ping", async () => {
    sendScanPing("ping-pkg", "safe", 90, registryUrl, "pypi");
    expect(answered).toBe(0);

    await scanPingsSettled();

    expect(answered).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/api/v1/contribute");
    expect(received[0].contributorToken).toBe("anonymous");
    const [event] = received[0].events as Array<Record<string, unknown>>;
    expect(event.type).toBe("scan_ping");
    expect(event.package).toEqual({ name: "ping-pkg", ecosystem: "pypi" });
  });

  it("waits for every ping in flight", async () => {
    sendScanPing("ping-a", "safe", 90, registryUrl);
    sendScanPing("ping-b", "warning", 40, registryUrl);

    await scanPingsSettled();

    expect(answered).toBe(2);
  });

  it("resolves, without rejecting, when the registry refuses the connection", async () => {
    // Port 1 on loopback: nothing listens there.
    sendScanPing("ping-pkg", "safe", 90, "http://127.0.0.1:1");

    await expect(scanPingsSettled()).resolves.toBeUndefined();
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
