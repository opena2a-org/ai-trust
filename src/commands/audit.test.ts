/**
 * Tests for the audit command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAuditCommand } from "./audit.js";

vi.mock("@opena2a/registry-client", () => ({
  firstPartySignerFromEnv: vi.fn().mockReturnValue(undefined),
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
import { parseDependencyFile, detectEcosystem } from "../utils/parser.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import { sendScanPing, isContributeEnabled, queueScanResult, saveContributeChoice } from "../telemetry/index.js";
import { confirm } from "../utils/prompt.js";

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

  it("tags every --json result with the ecosystem the file was queried under", async () => {
    vi.mocked(detectEcosystem).mockReturnValueOnce("pypi");
    vi.mocked(parseDependencyFile).mockResolvedValue([
      { name: "fastapi", ecosystem: "pypi" },
      { name: "pydantic", ecosystem: "pypi" },
    ]);
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "fastapi", found: true, trustLevel: 3, verdict: "safe" },
        { name: "pydantic", found: true, trustLevel: 3, verdict: "safe" },
      ],
      meta: { total: 2, found: 2, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "audit",
      "requirements.txt",
    ]);

    const printed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(printed.results).toHaveLength(2);
    for (const r of printed.results) {
      expect(r.ecosystem).toBe("pypi");
    }
    expect(printed.meta).toEqual({ total: 2, found: 2, notFound: 0 });
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

  it("publishes check IDs and results only, never finding names or messages, and sends the package version (#97)", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "leaky-pkg" }]);
    const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "leaky-pkg", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
          publishScan: mockPublishScan,
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanPackage).mockResolvedValue({
      packageName: "leaky-pkg",
      packageVersion: "4.5.6",
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
            message: 'does not match purpose "{ "mcpServers": { "leaky": {',
            file: "mcp.json",
            attackClass: "SCOPE-ESCALATION",
          },
        ],
        projectType: "mcp_server",
        timestamp: "2026-04-12T00:00:00Z",
      },
      trustScore: 0.7,
      trustLevel: 2,
      verdict: "warning",
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "audit", "package.json", "--scan-missing", "--contribute",
    ]);

    expect(mockPublishScan).toHaveBeenCalledOnce();
    const submission = mockPublishScan.mock.calls[0][0];
    const wire = JSON.stringify(submission);
    expect(wire).not.toContain("mcpServers");
    expect(wire).not.toContain("Scope mismatch");
    expect(submission.version).toBe("4.5.6");
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
    expect(queueScanResult).toHaveBeenCalledWith("leaky-pkg", expect.any(Array), 0, "npm", "4.5.6");
  });

  it("publishes a requirements.txt scan with ecosystem pypi, so the registry does not record it as npm", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "py-pkg" }]);
    vi.mocked(detectEcosystem).mockReturnValueOnce("pypi");
    const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "py-pkg", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
          publishScan: mockPublishScan,
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanPackage).mockResolvedValue({
      packageName: "py-pkg",
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
    await program.parseAsync([
      "node", "test", "audit", "requirements.txt", "--scan-missing", "--contribute",
    ]);

    expect(scanPackage).toHaveBeenCalledWith("py-pkg", expect.objectContaining({ ecosystem: "pypi" }));
    expect(mockPublishScan).toHaveBeenCalledOnce();
    expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
      name: "py-pkg",
      version: "0.9.1",
      ecosystem: "pypi",
    });
    expect(queueScanResult).toHaveBeenCalledWith("py-pkg", expect.any(Array), 0, "pypi", "0.9.1");
  });

  describe("share prompt on a terminal", () => {
    let savedIsTTY: boolean | undefined;
    const mockPublishScan = vi.fn();

    beforeEach(() => {
      savedIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      // The user presses Enter, which accepts the prompt's default (yes).
      vi.mocked(confirm).mockResolvedValue(true);
      vi.mocked(isContributeEnabled).mockReturnValue(undefined);
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "tty-pkg" }]);
      mockPublishScan.mockResolvedValue({ accepted: true });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            batchQuery: vi.fn().mockResolvedValue({
              results: [{ name: "tty-pkg", found: false }],
              meta: { total: 1, found: 0, notFound: 1 },
            }),
            publishScan: mockPublishScan,
          } as any;
        }
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "tty-pkg",
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

    afterEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: savedIsTTY, configurable: true });
      vi.mocked(confirm).mockResolvedValue(false);
    });

    it("asks to share when no choice is saved and no flag is given", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "test", "audit", "package.json", "--scan-missing"]);

      expect(confirm).toHaveBeenCalledWith("Share these scans with the community?", true);
      expect(mockPublishScan).toHaveBeenCalledOnce();
    });

    it("--no-contribute neither asks nor shares, and saves no choice (#96)", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
      ]);

      expect(confirm).not.toHaveBeenCalled();
      expect(saveContributeChoice).not.toHaveBeenCalled();
      expect(queueScanResult).not.toHaveBeenCalled();
      expect(mockPublishScan).not.toHaveBeenCalled();
      expect(sendScanPing).not.toHaveBeenCalled();
    });
  });
});
