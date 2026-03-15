/**
 * Tests for the check command logic, including scan-on-demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerCheckCommand } from "./check.js";

// Mock the API client, preserving the real PackageNotFoundError class
vi.mock("../api/client.js", async (importOriginal) => {
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

import {
  RegistryClient,
  PackageNotFoundError,
} from "../api/client.js";
import {
  formatCheckResult,
  formatScanResult,
  formatJson,
} from "../output/formatter.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";

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
    await program.parseAsync(["node", "test", "check", "my-pkg"]);

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
    ]);

    expect(formatJson).toHaveBeenCalled();
  });

  it("sets exit code 1 for blocked verdict", async () => {
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
    await program.parseAsync(["node", "test", "check", "bad-pkg"]);

    expect(process.exitCode).toBe(1);
  });

  it("sets exit code 1 for warning verdict", async () => {
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
    await program.parseAsync(["node", "test", "check", "risky-pkg"]);

    expect(process.exitCode).toBe(1);
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
    await program.parseAsync(["node", "test", "check", "good-pkg"]);

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
    await program.parseAsync(["node", "test", "check", "any-pkg"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: network failure"
    );
  });

  describe("scan-on-demand", () => {
    it("offers scan when package not found and --no-scan is not set", async () => {
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
      vi.mocked(isHmaAvailable).mockResolvedValue(false);

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "unknown-pkg",
      ]);

      // HMA not available, so it tells the user to install
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("not found")
      );
      expect(process.exitCode).toBe(1);
    });

    it("skips scan with --no-scan flag", async () => {
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

      expect(process.exitCode).toBe(1);
      // Should show the standard error, not offer scan
      expect(consoleErrSpy).toHaveBeenCalledWith(
        'Error: Package "unknown-pkg" not found in the OpenA2A Registry.'
      );
    });

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

      expect(scanPackage).toHaveBeenCalledWith("scan-me");
      expect(formatScanResult).toHaveBeenCalled();
    });

    it("auto-contributes with --scan-if-missing --contribute", async () => {
      const mockPublish = vi
        .fn()
        .mockResolvedValue({ accepted: true });
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
            publishScan: mockPublish,
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

      expect(mockPublish).toHaveBeenCalled();
    });

    it("sets exit code 1 when scan result is warning", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("risky-pkg")
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
          timestamp: "2026-03-14T00:00:00Z",
        },
        trustScore: 0.45,
        trustLevel: 1,
        verdict: "warning",
      });

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "risky-pkg",
        "--scan-if-missing",
      ]);

      expect(process.exitCode).toBe(1);
    });

    it("handles scan failure gracefully", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(
          new PackageNotFoundError("broken-pkg")
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
      vi.mocked(scanPackage).mockRejectedValue(
        new Error("download failed")
      );

      const program = createProgram();
      await program.parseAsync([
        "node",
        "test",
        "check",
        "broken-pkg",
        "--scan-if-missing",
      ]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        "Error: download failed"
      );
    });

    it("handles publish failure gracefully (non-fatal)", async () => {
      const mockPublish = vi
        .fn()
        .mockRejectedValue(new Error("registry down"));
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
            publishScan: mockPublish,
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

      // Scan results still shown, exit code not 1 (safe verdict)
      expect(formatScanResult).toHaveBeenCalled();
      // Publish error is non-fatal
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("registry down")
      );
    });
  });
});
