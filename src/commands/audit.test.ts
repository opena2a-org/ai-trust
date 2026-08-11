/**
 * Tests for the audit command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAuditCommand } from "./audit.js";

vi.mock("@opena2a/registry-client", () => ({
  RegistryClient: vi.fn().mockImplementation(function () {
    return {
      batchQuery: vi.fn(),
      publishScan: vi.fn().mockResolvedValue({ accepted: true }),
    };
  }),
  PackageNotFoundError: class PackageNotFoundError extends Error {
    public readonly packageName: string;
    constructor(name: string) {
      super(`Package "${name}" not found.`);
      this.name = "PackageNotFoundError";
      this.packageName = name;
    }
  },
}));

vi.mock("../utils/parser.js", () => ({
  parseDependencyFile: vi.fn(),
  detectEcosystem: vi.fn().mockReturnValue("npm"),
}));

vi.mock("../output/formatter.js", () => ({
  formatBatchResults: vi.fn(() => "formatted-batch"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
}));

vi.mock("../scanner/index.js", () => ({
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  scanPackage: vi.fn(),
}));

vi.mock("../utils/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

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

import { RegistryClient } from "@opena2a/registry-client";
import { parseDependencyFile } from "../utils/parser.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import { sendScanPing, isContributeEnabled } from "../telemetry/index.js";

function createProgram(): Command {
  const program = new Command();
  program
    .option("--registry-url <url>", "registry base URL", "https://api.test.com")
    .option("--json", "output raw JSON", false);
  registerAuditCommand(program);
  return program;
}

describe("audit command", () => {
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

  it("reports when no dependencies are found", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([]);

    const program = createProgram();
    await program.parseAsync(["node", "test", "audit", "package.json"]);

    expect(consoleSpy).toHaveBeenCalledWith(
      "No dependencies found in the specified file."
    );
  });

  it("rejects invalid min-trust values", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "audit",
      "package.json",
      "--min-trust",
      "abc",
    ]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: --min-trust must be a number between 0 and 4"
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects min-trust above 4", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "audit",
      "package.json",
      "--min-trust",
      "5",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("rejects more than 100 dependencies", async () => {
    const manyDeps = Array.from({ length: 101 }, (_, i) => ({
      name: `pkg-${i}`,
    }));
    vi.mocked(parseDependencyFile).mockResolvedValue(manyDeps);

    const program = createProgram();
    await program.parseAsync(["node", "test", "audit", "package.json"]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Too many dependencies (101)")
    );
    expect(process.exitCode).toBe(1);
  });

  it("sets exit code 2 when packages are below threshold", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "risky-pkg" }]);
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "risky-pkg", found: true, trustLevel: 1, verdict: "warning" },
      ],
      meta: { total: 1, found: 1, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "audit", "package.json"]);

    expect(process.exitCode).toBe(2);
  });

  it("shows friendly error for ENOENT (missing file)", async () => {
    const enoentError = new Error(
      "ENOENT: no such file or directory, open 'nonexistent.json'"
    ) as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";
    vi.mocked(parseDependencyFile).mockRejectedValue(enoentError);

    const program = createProgram();
    await program.parseAsync(["node", "test", "audit", "nonexistent.json"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: File not found: nonexistent.json"
    );
  });

  it("sets exit code 1 on parser error", async () => {
    vi.mocked(parseDependencyFile).mockRejectedValue(
      new Error("File not found")
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "audit", "package.json"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith("Error: File not found");
  });

  describe("scan ping consent gating (regression: package name + verdict + score is scan-result data, requires the same consent as full contribution)", () => {
    beforeEach(() => {
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "ping-pkg" }]);
      const mockBatchQuery = vi.fn().mockResolvedValue({
        results: [{ name: "ping-pkg", found: false }],
        meta: { total: 1, found: 0, notFound: 1 },
      });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
        }
      );
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
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing",
      ]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });

    it("pings when --contribute is passed", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--contribute",
      ]);

      expect(sendScanPing).toHaveBeenCalled();
    });

    it("--no-contribute is a registered option and does not error", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);

      const program = createProgram();
      await expect(
        program.parseAsync([
          "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
        ])
      ).resolves.not.toThrow();
    });

    it("--no-contribute overrides a persisted opt-in and suppresses the ping", async () => {
      vi.mocked(isContributeEnabled).mockReturnValue(true);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
      ]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });
  });
});
