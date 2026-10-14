/**
 * Tests for the check command logic, including scan-on-demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCheckCommand } from "./check.js";

// Mock the API client, preserving the real PackageNotFoundError class
vi.mock("@opena2a/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    RegistryClient: vi.fn().mockImplementation(function () {
      return {
        checkTrust: vi.fn(),
        publishScan: vi.fn(),
      };
    }),
  };
});

// Mock formatter (ecosystemSuffix is the real helper: it only builds a label)
vi.mock("../output/formatter.js", async (importOriginal) => ({
  ecosystemSuffix: (await importOriginal<typeof import("../output/formatter.js")>())
    .ecosystemSuffix,
  formatCheckResult: vi.fn(() => "formatted-check-result"),
  formatScanResult: vi.fn(() => "formatted-scan-result"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
  formatNotFound: vi.fn(() => "formatted-not-found"),
  translateDownloadError: vi.fn(() => undefined),
}));

// Mock scanner
vi.mock("../scanner/index.js", () => ({
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  reinstallCommand: vi.fn().mockReturnValue("cd /work/project && npm install"),
  scanPackage: vi.fn(),
  scanLocalPath: vi.fn(),
}));

// Mock prompt
vi.mock("../utils/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

// Mock telemetry
vi.mock("../telemetry/index.js", () => {
  const isContributeEnabled = vi.fn().mockReturnValue(undefined);
  return {
    isContributeEnabled,
    // Mirrors the real resolveContributeChoice: an explicit flag beats
    // config either way; only an unset flag falls through to config.
    resolveContributeChoice: vi.fn((flag: boolean | undefined) => {
      if (flag === true) return true;
      if (flag === false) return false;
      return isContributeEnabled() === true;
    }),
    recordScanAndMaybeShowTip: vi.fn().mockReturnValue(null),
    queueScanResult: vi.fn(),
    flushQueue: vi.fn().mockResolvedValue(false),
    saveContributeChoice: vi.fn(),
    sendScanPing: vi.fn(),
  };
});

import {
  RegistryClient,
  PackageNotFoundError,
} from "@opena2a/registry-client";
import {
  formatCheckResult,
  formatScanResult,
  formatJson,
  formatNotFound,
} from "../output/formatter.js";
import { isHmaAvailable, scanPackage, scanLocalPath } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import {
  queueScanResult,
  flushQueue,
  sendScanPing,
  isContributeEnabled,
} from "../telemetry/index.js";

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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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

    it("emits the curated camelCase JSON shape (source=registry) under --json", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "my-mcp",
        found: true,
        verdict: "passed",
        trustLevel: 3,
        trustScore: 0.82,
        packageType: "mcp_server",
      });
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: mockCheckTrust,
          batchQuery: vi.fn(),
          publishScan: vi.fn(),
        } as any;
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "--json",
        "check",
        "my-mcp",
        "--no-scan",
      ]);

      // formatJson is mocked to JSON.stringify(data); assert the object it
      // received is the curated trust shape, not the raw TrustAnswer dump.
      expect(formatJson).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "my-mcp",
          source: "registry",
          found: true,
          verdict: "passed",
          trustLevel: 3,
          trustScore: 0.82,
          packageType: "mcp_server",
        })
      );
      // The curated registry shape must NOT carry scan-only fields.
      const arg = vi.mocked(formatJson).mock.calls[0][0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty("score");
      expect(arg).not.toHaveProperty("maxScore");
      // Stdout output must be valid JSON.
      const printed = consoleSpy.mock.calls.at(-1)?.[0] as string;
      expect(() => JSON.parse(printed)).not.toThrow();
    });

    it("sets exit code 2 for blocked verdict (policy signal)", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "bad-pkg",
        found: true,
        verdict: "blocked",
        trustLevel: 0,
      });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
      // Post cli-ui 0.3.0 migration, human-readable output routes through
      // formatNotFound -> console.log (not console.error). formatNotFound is
      // mocked at the top of the file, so we assert the routing + call shape
      // rather than grepping the stubbed text.
      expect(formatNotFound).toHaveBeenCalledWith(
        expect.objectContaining({ pkg: "unknown-pkg", ecosystem: "npm" })
      );
    });

    it("points a --json registry miss at the default scan, not the no-op --scan-if-missing (#98)", async () => {
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi
              .fn()
              .mockRejectedValue(new PackageNotFoundError("unknown-pkg")),
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "unknown-pkg",
        "--no-scan",
        "--json",
      ]);

      expect(process.exitCode).toBe(2);
      const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      // Dropping --no-scan is what scans the package; --scan-if-missing
      // changes nothing because every package is scanned by default.
      expect(out.nextSteps[0]).toBe("ai-trust check unknown-pkg");
      for (const step of out.nextSteps) {
        expect(step).not.toContain("--scan-if-missing");
      }
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

      expect(scanPackage).toHaveBeenCalledWith("my-pkg", { deep: true, ecosystem: "npm" });
      expect(formatScanResult).toHaveBeenCalled();
    });

    it("scans and contributes a pip: target as the PyPI package, not the npm package of the same name", async () => {
      const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("server-py")),
            publishScan: mockPublishScan,
          } as any;
        }
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "server-py",
        packageVersion: "0.9.1",
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
      await program.parseAsync(["node", "test", "check", "pip:server-py", "--contribute"]);

      // Used as given: the npm-only MCP shorthand does not rewrite it.
      expect(scanPackage).toHaveBeenCalledWith("server-py", { deep: true, ecosystem: "pypi" });
      expect(sendScanPing).toHaveBeenCalledWith(
        "server-py", "safe", 90, "https://api.test.com", "pypi"
      );
      expect(queueScanResult).toHaveBeenCalledWith("server-py", expect.any(Array), 0, "pypi", "0.9.1");
      expect(mockPublishScan).toHaveBeenCalledOnce();
      expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
        name: "server-py",
        ecosystem: "pypi",
      });
    });

    it("shows HMA install message when HMA is not available", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(false);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg"]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("HMA (HackMyAgent) is required")
      );
      // The reinstall command fits the install, not always a global one.
      expect(consoleErrSpy).toHaveBeenCalledWith("  cd /work/project && npm install");
      expect(consoleErrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("npm install -g ai-trust")
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

  describe("scan ping consent gating (regression: package name + verdict + score is scan-result data, requires the same consent as full contribution)", () => {
    beforeEach(() => {
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "ping-pkg",
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
    });

    it("does NOT ping when contribution has never been configured (default state)", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "ping-pkg"]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });

    it("pings when --contribute is passed", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "check", "ping-pkg", "--contribute",
      ]);

      expect(sendScanPing).toHaveBeenCalledWith(
        "ping-pkg", "safe", 90, "https://api.test.com", "npm"
      );
    });

    it("pings when contribution is enabled via persisted config, with no flag", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(true);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "ping-pkg"]);

      expect(sendScanPing).toHaveBeenCalled();
    });

    it("--no-contribute is a registered option and does not error", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);

      const program = createProgram();
      // Regression for the exact reported bug: this used to throw
      // "error: unknown option '--no-contribute'" because the flag was
      // advertised in --help but never registered with Commander.
      await expect(
        program.parseAsync(["node", "test", "check", "ping-pkg", "--no-contribute"])
      ).resolves.not.toThrow();
    });

    it("--no-contribute overrides a persisted opt-in and suppresses the ping", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(true);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "check", "ping-pkg", "--no-contribute",
      ]);

      expect(sendScanPing).not.toHaveBeenCalled();
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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

      expect(scanPackage).toHaveBeenCalledWith("scan-me", { deep: true, ecosystem: "npm" });
      expect(formatScanResult).toHaveBeenCalled();
    });

    it("auto-contributes telemetry with --scan-if-missing --contribute", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("scan-me")
        );
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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

    it("publishes check IDs and results only, never finding names or messages, and sends the package version (#97)", async () => {
      const leaked = '"mcp.leaky.*" does not match purpose "{ "mcpServers": { "leaky": { "command": "node"';
      const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("scan-me")),
            batchQuery: vi.fn(),
            publishScan: mockPublishScan,
          } as any;
        }
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "scan-me",
        packageVersion: "1.2.3",
        scan: {
          score: 70,
          maxScore: 100,
          findings: [
            {
              checkId: "AST-SCOPE-003",
              name: "Scope mismatch in mcp.json",
              description: "Declared capability exceeds stated purpose",
              category: "scope",
              severity: "medium",
              passed: false,
              message: leaked,
              file: "mcp.json",
              line: 1,
              fix: "Narrow the declared scope",
              attackClass: "SCOPE-ESCALATION",
            },
          ],
          projectType: "mcp_server",
          timestamp: "2026-03-14T00:00:00Z",
        },
        trustScore: 0.7,
        trustLevel: 2,
        verdict: "warning",
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

      expect(mockPublishScan).toHaveBeenCalledOnce();
      const submission = mockPublishScan.mock.calls[0][0];
      const wire = JSON.stringify(submission);
      expect(wire).not.toContain("mcpServers");
      expect(wire).not.toContain("Scope mismatch in mcp.json");
      expect(wire).not.toContain("mcp.json");
      expect(submission.version).toBe("1.2.3");
      expect(submission.findings).toEqual([
        {
          checkId: "AST-SCOPE-003",
          name: "AST-SCOPE-003",
          severity: "medium",
          passed: false,
          message: "",
          category: "scope",
          attackClass: "SCOPE-ESCALATION",
        },
      ]);
      expect(queueScanResult).toHaveBeenCalledWith(
        "scan-me",
        expect.any(Array),
        0,
        "npm",
        "1.2.3"
      );
    });

    it("contributes silently once consent is given (no per-scan contribution line)", async () => {
      vi.mocked(flushQueue).mockResolvedValue(true);
      const mockPublishScan = vi
        .fn()
        .mockResolvedValue({ publishId: "0123456789abcdef" });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi
              .fn()
              .mockRejectedValue(new PackageNotFoundError("scan-me")),
            batchQuery: vi.fn(),
            publishScan: mockPublishScan,
          } as any;
        }
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
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      try {
        const program = createProgram();
        await program.parseAsync([
          "node",
          "test",
          "check",
          "scan-me",
          "--scan-if-missing",
          "--contribute",
        ]);
      } finally {
        stderrSpy.mockRestore();
        vi.mocked(flushQueue).mockResolvedValue(false);
      }

      // The contribution still happens...
      expect(queueScanResult).toHaveBeenCalled();
      expect(flushQueue).toHaveBeenCalled();
      expect(mockPublishScan).toHaveBeenCalled();
      // ...but nothing about it is printed.
      const printed = [
        ...consoleSpy.mock.calls,
        ...consoleErrSpy.mock.calls,
        ...stderrSpy.mock.calls,
      ]
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(printed).not.toMatch(/shared with the community/i);
      expect(printed).not.toMatch(/Thank you for building trust/i);
      expect(printed).not.toMatch(/Published to registry/i);
      expect(printed).not.toContain("01234567");
    });

    it("handles telemetry failure gracefully (non-fatal)", async () => {
      vi.mocked(flushQueue).mockResolvedValue(false);
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("scan-me")
        );
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "express", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("express", undefined);
      // AI-TRUST-1: per v0.3 spec, libraries get out-of-scope only — no
      // trust block. Showing both surfaced a misleading "Scan failed —
      // score is unreliable" line on errored library scans on top of the
      // out-of-scope CTA.
      expect(formatCheckResult).not.toHaveBeenCalled();
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
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

    it("AI-TRUST-1: registry-confirmed library renders ONLY out-of-scope CTA, not the trust block", async () => {
      // Per v0.3 spec, Tier 3 libraries are out of ai-trust's scope and
      // get the redirect to HMA. The earlier behavior rendered
      // formatCheckResult on top, which on errored scans surfaced
      // "Scan failed — score is unreliable" stacked on the out-of-scope
      // notice — confusing two unrelated concerns. The full trust read
      // for libraries lives in `hackmyagent check`.
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "chalk",
        found: true,
        verdict: "safe",
        trustLevel: 3,
        trustScore: 0.82,
        packageType: "library",
        scanStatus: "error",
      });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: mockCheckTrust,
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        }
      );

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "chalk", "--no-scan"]);

      expect(formatCheckResult).not.toHaveBeenCalled();
    });
  });

  describe("AI_TRUST_CLI_PREFIX self-citations (#191)", () => {
    function checkHelp(): string {
      const program = createProgram();
      const cmd = program.commands.find((c) => c.name() === "check")!;
      let out = "";
      cmd.configureOutput({ writeOut: (s) => (out += s) });
      cmd.outputHelp();
      return out;
    }

    afterEach(() => {
      delete process.env.AI_TRUST_CLI_PREFIX;
    });

    it("renders 'opena2a registry' and zero 'ai-trust check' when prefixed", () => {
      process.env.AI_TRUST_CLI_PREFIX = "opena2a registry";
      const help = checkHelp();
      expect(help).toContain("Usage: opena2a registry [options] <name>");
      expect(help).toContain("opena2a registry @modelcontextprotocol/server-filesystem");
      expect(help).not.toContain("ai-trust check");
    });

    it("renders native 'ai-trust check' when AI_TRUST_CLI_PREFIX is unset", () => {
      delete process.env.AI_TRUST_CLI_PREFIX;
      const help = checkHelp();
      expect(help).toContain("Usage: ai-trust check [options] <name>");
      expect(help).toContain("ai-trust check @modelcontextprotocol/server-filesystem");
      expect(help).not.toContain("opena2a registry");
    });
  });

  describe("help text matches the local-scan default (#98)", () => {
    function checkHelp(): string {
      const program = createProgram();
      const cmd = program.commands.find((c) => c.name() === "check")!;
      let out = "";
      cmd.configureOutput({ writeOut: (s) => (out += s) });
      cmd.outputHelp();
      return out;
    }

    it("describes check as a scan, with --no-scan as the registry lookup", () => {
      const help = checkHelp();
      expect(help).not.toContain("Look up trust information");
      expect(help).toMatch(/scan/i);
      expect(help).toMatch(/--no-scan\s+registry lookup only/);
    });

    it("marks --scan-if-missing as a no-op and never recommends it", () => {
      const help = checkHelp();
      expect(help).not.toContain("auto-scan packages not in registry");
      expect(help).toMatch(/--scan-if-missing\s+deprecated/);
      expect(help).not.toMatch(/ai-trust check \S+ --scan-if-missing/);
    });
  });
});

// The documented exit-code contract is checked against the exit code the
// command actually sets, so the exit-code table in docs/commands.md cannot drift from the code again
// (it once had no row for not-found or out-of-scope).
describe("documented exit codes match check outcomes", () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readDoc = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

  // Rows of the docs/commands.md "## Exit codes" table as `| <code> | <Outcome>: ... |`.
  function documentedExitCodes(): Map<string, number> {
    const section =
      readDoc("docs/commands.md").split(/^## Exit codes$/m)[1]?.split(/^## /m)[0] ?? "";
    const rows = new Map<string, number>();
    for (const m of section.matchAll(/^\| (\d) \| ([^:|]+):/gm)) {
      rows.set(m[2].trim(), Number(m[1]));
    }
    return rows;
  }

  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  const outcomes: { outcome: string; name: string; registry: () => Promise<unknown> }[] = [
    {
      outcome: "Safe",
      name: "good-pkg",
      registry: async () => ({ name: "good-pkg", found: true, verdict: "safe", trustLevel: 3 }),
    },
    {
      outcome: "Out of scope",
      name: "express",
      registry: async () => ({
        name: "express",
        found: true,
        verdict: "safe",
        trustLevel: 3,
        packageType: "library",
      }),
    },
    {
      outcome: "Operational error",
      name: "some-pkg",
      registry: async () => {
        throw new Error("network failure");
      },
    },
    {
      outcome: "Warning or blocked",
      name: "risky-pkg",
      registry: async () => ({ name: "risky-pkg", found: true, verdict: "warning", trustLevel: 1 }),
    },
    {
      outcome: "Not found",
      name: "nonexistent-xyz-999",
      registry: async () => {
        throw new PackageNotFoundError("nonexistent-xyz-999");
      },
    },
  ];

  for (const { outcome, name, registry } of outcomes) {
    it(`Exit-code table row "${outcome}" gives the code check sets`, async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(registry), batchQuery: vi.fn(), publishScan: vi.fn() } as any;
      });

      await createProgram().parseAsync(["node", "test", "check", name, "--no-scan"]);

      const documented = documentedExitCodes().get(outcome);
      expect(documented, `docs/commands.md exit-code table has no "${outcome}" row`).toBeDefined();
      expect(process.exitCode ?? 0).toBe(documented);
    });
  }

  it("the exit-code table documents below-threshold as exit 2 (behavior pinned in batch.test.ts)", () => {
    expect(documentedExitCodes().get("Below threshold")).toBe(2);
  });

  it('Exit-code table row "Local scan" gives the code check --scan-path sets for a blocked verdict', async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockResolvedValue({
      packageName: "fixture",
      scan: {
        score: 0,
        maxScore: 100,
        findings: [],
        projectType: "repo",
        timestamp: "2026-03-14T00:00:00Z",
      },
      trustScore: 0,
      trustLevel: 0,
      verdict: "blocked",
    });

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/fixture"]);

    const documented = documentedExitCodes().get("Local scan");
    expect(documented, 'docs/commands.md exit-code table has no "Local scan" row').toBeDefined();
    expect(process.exitCode ?? 0).toBe(documented);
  });

  it('Exit-code table row "Local scan could not run" gives the code check --scan-path exits with', async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockRejectedValue(new Error("ENOENT: no such file or directory"));
    let exitCode: number | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("process.exit");
    }) as never);
    try {
      await createProgram()
        .parseAsync(["node", "test", "check", "fixture", "--scan-path", "/nonexistent"])
        .catch(() => {});
    } finally {
      exit.mockRestore();
    }

    const documented = documentedExitCodes().get("Local scan could not run");
    expect(documented, 'docs/commands.md exit-code table has no "Local scan could not run" row').toBeDefined();
    expect(exitCode).toBe(documented);
  });

  it("release checklist and changelog do not contradict the exit-code table", () => {
    const smoke = readDoc("docs/testing/release-smoke.md");
    expect(smoke).toMatch(/check express --no-scan .*exit 0/);
    expect(smoke).not.toMatch(/1 for errors\/high-risk/);
    expect(smoke).not.toMatch(/2 for not-found\/out-of-scope/);
    expect(readDoc("CHANGELOG.md")).not.toContain("exit 1 for below-threshold");
    expect(readDoc("docs/use-cases/check-before-install.md")).toMatch(
      /# Exit code 0 = safe or out of scope, 1 = operational error, 2 = warning, blocked or not found/,
    );
  });
});
