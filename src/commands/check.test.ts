/**
 * Tests for the check command logic, including scan-on-demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerCheckCommand } from "./check.js";

// Mock the API client, preserving the real PackageNotFoundError class
vi.mock("@opena2a/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    RegistryClient: vi.fn().mockImplementation(() => ({
      checkTrust: vi.fn(),
      publishScan: vi.fn(),
    })),
  };
});

// Mock formatter
vi.mock("../output/formatter.js", () => ({
  formatCheckResult: vi.fn(() => "formatted-check-result"),
  formatScanResult: vi.fn(() => "formatted-scan-result"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
}));

// Mock scanner
vi.mock("../scanner/index.js", () => ({
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  scanPackage: vi.fn(),
}));

// Mock prompt
vi.mock("../utils/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

// Mock telemetry
vi.mock("../telemetry/index.js", () => ({
  isContributeEnabled: vi.fn().mockReturnValue(undefined),
  recordScanAndMaybeShowTip: vi.fn().mockReturnValue(null),
  queueScanResult: vi.fn(),
  flushQueue: vi.fn().mockResolvedValue(false),
  saveContributeChoice: vi.fn(),
  sendScanPing: vi.fn(),
}));

import {
  RegistryClient,
  PackageNotFoundError,
} from "@opena2a/registry-client";
import {
  formatCheckResult,
  formatScanResult,
  formatJson,
} from "../output/formatter.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import { queueScanResult, flushQueue } from "../telemetry/index.js";

function createProgram(): Command {
  const program = new Command();
  program
    .option(
      "--registry-url <url>",
      "registry base URL",
      "https://api.test.com"
    )
    .option("--json", "output raw JSON", false);
  registerCheckCommand(program);
  return program;
}

describe("check command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  describe("--no-scan (registry-only mode)", () => {
    it("calls client.checkTrust with the package name", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "my-pkg",
        found: true,
        verdict: "safe",
        trustLevel: 3,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("my-pkg", undefined);
    });

    it("passes type option to checkTrust", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "my-pkg",
        found: true,
        verdict: "safe",
        trustLevel: 3,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "my-pkg",
        "-t",
        "mcp_server",
        "--no-scan",
      ]);

      expect(mockCheckTrust).toHaveBeenCalledWith("my-pkg", "mcp_server");
    });

    it("uses formatJson when --json flag is set", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "my-pkg",
        found: true,
        verdict: "safe",
        trustLevel: 3,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "--json",
        "check",
        "my-pkg",
        "--no-scan",
      ]);

      expect(formatJson).toHaveBeenCalled();
    });

    it("sets exit code 2 for blocked verdict (policy signal)", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "bad-pkg",
        found: true,
        verdict: "blocked",
        trustLevel: 0,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "bad-pkg", "--no-scan"]);

      expect(process.exitCode).toBe(2);
    });

    it("sets exit code 2 for warning verdict (policy signal)", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "risky-pkg",
        found: true,
        verdict: "warning",
        trustLevel: 1,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "risky-pkg", "--no-scan"]);

      expect(process.exitCode).toBe(2);
    });

    it("does not set exit code for safe verdict", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "good-pkg",
        found: true,
        verdict: "safe",
        trustLevel: 4,
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "good-pkg", "--no-scan"]);

      expect(process.exitCode).toBeUndefined();
    });

    it("sets exit code 1 on API error", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(new Error("network failure"));
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "any-pkg", "--no-scan"]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        "Error: network failure"
      );
    });

    it("shows not-found message with actionable next steps", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("unknown-pkg")
        );
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "unknown-pkg",
        "--no-scan",
      ]);

      expect(process.exitCode).toBe(2);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("not found in the OpenA2A Registry")
      );
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("--scan-if-missing")
      );
    });
  });

  describe("default (local scan)", () => {
    it("triggers local HMA scan by default", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "my-pkg",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-04-12T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg"]);

      expect(scanPackage).toHaveBeenCalledWith("my-pkg", { deep: true });
      expect(formatScanResult).toHaveBeenCalled();
    });

    it("shows HMA install message when HMA is not available", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(false);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg"]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("HMA (HackMyAgent) is required")
      );
    });

    it("sets exit code 2 for warning verdict from scan", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "risky-pkg",
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
            },
          ],
          projectType: "library",
          timestamp: "2026-04-12T00:00:00Z",
        },
        trustScore: 0.45,
        trustLevel: 1,
        verdict: "warning",
      });

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "risky-pkg"]);

      expect(process.exitCode).toBe(2);
    });

    it("handles scan failure gracefully", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockRejectedValue(
        new Error("download failed")
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "broken-pkg"]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        "Error: download failed"
      );
    });

    it("--rescan shows deprecation notice but still scans", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "my-pkg",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-04-12T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg", "--rescan"]);

      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("--rescan is deprecated")
      );
      expect(scanPackage).toHaveBeenCalled();
    });
  });

  describe("scan-on-demand (--scan-if-missing)", () => {
    it("auto-scans with --scan-if-missing when HMA is available", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("scan-me")
        );
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "scan-me",
        scan: {
          score: 85,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-03-14T00:00:00Z",
        },
        trustScore: 0.85,
        trustLevel: 2,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "scan-me",
        "--scan-if-missing",
      ]);

      expect(scanPackage).toHaveBeenCalledWith("scan-me", { deep: true });
      expect(formatScanResult).toHaveBeenCalled();
    });

    it("auto-contributes telemetry with --scan-if-missing --contribute", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("scan-me")
        );
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "scan-me",
        scan: {
          score: 85,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-03-14T00:00:00Z",
        },
        trustScore: 0.85,
        trustLevel: 2,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "scan-me",
        "--scan-if-missing",
        "--contribute",
      ]);

      expect(queueScanResult).toHaveBeenCalled();
    });

    it("handles telemetry failure gracefully (non-fatal)", async () => {
      vi.mocked(flushQueue).mockResolvedValue(false);
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("scan-me")
        );
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "scan-me",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-03-14T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "scan-me",
        "--scan-if-missing",
        "--contribute",
      ]);

      // Scan results still shown, exit code not set (safe verdict)
      expect(formatScanResult).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("scope — registry authoritative, name-only allowlist last", () => {
    it("routes a registry-confirmed library to HMA without scanning (--no-scan)", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "express",
        found: true,
        verdict: "safe",
        trustLevel: 3,
        packageType: "library",
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "express", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("express", undefined);
      // Trust data is still shown alongside the out-of-scope note
      expect(formatCheckResult).toHaveBeenCalled();
      // Out of scope is informational — exit 0, not 2
      expect(process.exitCode).toBeUndefined();
    });

    it("BYPASS GUARD: does not silently skip a novel @types/* package the registry has not seen", async () => {
      // Regression: an earlier version classified by name BEFORE the registry
      // lookup, so an attacker publishing @types/<anything> would be routed
      // away with no scan and no registry check. The fix: always consult the
      // registry first; if not found, the scan path runs.
      const mockCheckTrust = vi.fn().mockRejectedValue(new PackageNotFoundError("not in registry"));
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "@types/malicious-mcp",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-04-21T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "@types/malicious-mcp",
        "--scan-if-missing",
      ]);

      // The registry was consulted first
      expect(mockCheckTrust).toHaveBeenCalled();
      // And because the registry did not know this package, the scan ran
      // instead of a silent name-only dismissal.
      expect(scanPackage).toHaveBeenCalled();
    });

    it("name-only allowlist applies only when the registry has no data (--no-scan)", async () => {
      // This exercises the legitimate case: user runs `check express --no-scan`
      // against a registry that has no record (unusual, but possible). The
      // exact-name match in the allowlist is reliable because npm namespace
      // uniqueness prevents a new "express" from being published.
      const mockCheckTrust = vi.fn().mockRejectedValue(new PackageNotFoundError("not in registry"));
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "express", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalled();
      // Exit 0 — out-of-scope by name, not a failure
      expect(process.exitCode).toBeUndefined();
    });

    it("propagates blocked verdict on a library via exit code 2 (--no-scan)", async () => {
      // A registry-flagged library must not lose its policy signal just
      // because it's out of ai-trust's normal audit scope. CI consumers
      // gating on exit != 0 should still catch the blocked verdict.
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "compromised-lib",
        found: true,
        verdict: "blocked",
        trustLevel: 0,
        trustScore: 0.1,
        packageType: "library",
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "compromised-lib",
        "--no-scan",
      ]);

      expect(process.exitCode).toBe(2);
    });

    it("still surfaces trust data for a registry-confirmed library (--no-scan)", async () => {
      // Regression: the previous implementation dismissed the registry's
      // trust answer entirely when packageType=library, so a user who
      // asked about a library got "Out of scope" with NO trust info at
      // all — even when the registry had useful data (verdict, publisher).
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "chalk",
        found: true,
        verdict: "safe",
        trustLevel: 3,
        trustScore: 0.82,
        packageType: "library",
      });
      vi.mocked(RegistryClient).mockImplementation(
        () =>
          ({
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          }) as any
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "chalk", "--no-scan"]);

      // formatCheckResult was called — the user sees the registry's data,
      // not just a bare "go away" message.
      expect(formatCheckResult).toHaveBeenCalled();
    });
  });
});
