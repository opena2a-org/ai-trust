/**
 * Tests for community contribution module.
 *
 * Verifies:
 *   - Legacy payload structure matches server-side schema (backward compat)
 *   - No PII (file paths, line numbers, descriptions, fix text) in payload
 *   - Contributor token is stable across calls
 *   - Queue-based submission handles errors gracefully
 *   - queueScanResult produces correct summary events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  queueScanResult,
  flushQueue,
  type ContributionPayload,
} from "./contribute.js";
import type { HmaFinding } from "../scanner/hma.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-trust-contribute-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

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
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
  });

  it("writes a queue file with the correct event format", () => {
    queueScanResult("test-pkg", makeSampleFindings());

    const queueFile = path.join(tempHome, "contribute-queue.json");
    expect(fs.existsSync(queueFile)).toBe(true);

    const queue = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
    expect(queue.events).toHaveLength(1);

    const event = queue.events[0];
    expect(event.type).toBe("scan_result");
    expect(event.tool).toBe("ai-trust");
    expect(event.toolVersion).toBeTruthy();
    expect(event.package.name).toBe("test-pkg");
    expect(event.package.ecosystem).toBe("npm");
    expect(event.scanSummary).toBeDefined();
    expect(event.scanSummary.totalChecks).toBe(3);
    expect(event.scanSummary.passed).toBe(1);
    expect(event.scanSummary.critical).toBe(1);
    expect(event.scanSummary.high).toBe(1);
    expect(event.scanSummary.medium).toBe(0);
    expect(event.scanSummary.low).toBe(0);
  });

  it("does not contain file paths or descriptions in the queue", () => {
    queueScanResult("test-pkg", makeSampleFindings());

    const queueFile = path.join(tempHome, "contribute-queue.json");
    const serialized = fs.readFileSync(queueFile, "utf-8");

    expect(serialized).not.toContain("src/config.ts");
    expect(serialized).not.toContain(".mcp/config.json");
    expect(serialized).not.toContain("Found hardcoded API key");
    expect(serialized).not.toContain("API key sk-1234");
    expect(serialized).not.toContain("Remove the key");
    expect(serialized).not.toContain("chmod 600");
  });

  it("accumulates multiple events in the queue", () => {
    queueScanResult("pkg-a", makeSampleFindings());
    queueScanResult("pkg-b", []);

    const queueFile = path.join(tempHome, "contribute-queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
    expect(queue.events).toHaveLength(2);
    expect(queue.events[0].package.name).toBe("pkg-a");
    expect(queue.events[1].package.name).toBe("pkg-b");
  });

  it("computes score as percentage of passed checks", () => {
    queueScanResult("test-pkg", makeSampleFindings()); // 1/3 passed

    const queueFile = path.join(tempHome, "contribute-queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
    expect(queue.events[0].scanSummary.score).toBe(33); // Math.round(1/3 * 100)
  });

  it("handles empty findings with score 0", () => {
    queueScanResult("empty-pkg", []);

    const queueFile = path.join(tempHome, "contribute-queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
    expect(queue.events[0].scanSummary.score).toBe(0);
    expect(queue.events[0].scanSummary.totalChecks).toBe(0);
  });
});

describe("generateContributorToken", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
  });

  it("returns a 64-char hex string (SHA256)", () => {
    const token = generateContributorToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    const token1 = generateContributorToken();
    const token2 = generateContributorToken();
    expect(token1).toBe(token2);
  });

  it("creates contributor-salt file with restricted permissions", () => {
    generateContributorToken();
    const saltPath = path.join(tempHome, "contributor-salt");
    expect(fs.existsSync(saltPath)).toBe(true);

    const stat = fs.statSync(saltPath);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});

describe("submitContribution (legacy)", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
  });

  it("handles network errors gracefully", async () => {
    const payload = buildContributionPayload("test-pkg", makeSampleFindings());
    // Use a URL that will fail immediately
    const result = await submitContribution(
      payload,
      "http://localhost:1"
    );

    expect(result.success).toBe(false);
  });
});

describe("flushQueue", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
  });

  it("returns true when queue is empty", async () => {
    const result = await flushQueue("http://localhost:1");
    expect(result).toBe(true);
  });

  it("handles network errors without throwing", async () => {
    queueScanResult("test-pkg", makeSampleFindings());
    const result = await flushQueue("http://localhost:1");
    expect(result).toBe(false);
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
