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

// Mock formatter (ecosystemSuffix is the real helper: it only builds a label;
// showsRegistryScore is the real test of whether the scan output prints the
// registry's score beside the scan's)
vi.mock("../output/formatter.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../output/formatter.js")>();
  return {
    ecosystemSuffix: real.ecosystemSuffix,
    showsRegistryScore: real.showsRegistryScore,
    formatCheckResult: vi.fn(() => "formatted-check-result"),
    formatScanResult: vi.fn(() => "formatted-scan-result"),
    formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
    formatNotFound: vi.fn(() => "formatted-not-found"),
    translateDownloadError: vi.fn(() => undefined),
  };
});

// Mock scanner
vi.mock("../scanner/index.js", () => ({
  HmaScanError: class HmaScanError extends Error {},
  ScanPathError: class ScanPathError extends Error {},
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  reinstallCommand: vi.fn().mockReturnValue("cd /work/project && npm install"),
  scanPackage: vi.fn(),
  scanLocalPath: vi.fn(),
  scannerNodeVersionProblem: vi.fn().mockReturnValue(null),
  scannerTempDirProblem: vi.fn().mockReturnValue(null),
}));

// Mock prompt
vi.mock("../utils/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

// The saved choice, the scan ping and the contribute library are mocked;
// the decision and the contribution flow are the real ones.
vi.mock("../telemetry/opt-in.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/opt-in.js")>()),
  readContributeChoice: vi.fn().mockReturnValue(undefined),
  recordScanAndMaybeShowTip: vi.fn().mockReturnValue(null),
  saveContributeChoice: vi.fn(),
}));
vi.mock("../telemetry/contribute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/contribute.js")>()),
  sendScanPing: vi.fn(),
}));
vi.mock("@opena2a/contribute", () => ({
  contribute: {
    scanResult: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(false),
  },
  getContributorToken: vi.fn().mockReturnValue("a".repeat(64)),
}));

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
import {
  HmaScanError,
  isHmaAvailable,
  scanPackage,
  scanLocalPath,
  scannerNodeVersionProblem,
  ScanPathError,
} from "../scanner/index.js";
import type { AnalystLayerStatus, ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import { sendScanPing } from "../telemetry/contribute.js";
import { readContributeChoice } from "../telemetry/opt-in.js";
import { contribute } from "@opena2a/contribute";

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

    it("quotes a --json registry miss name with shell syntax in nextSteps (#218)", async () => {
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi
              .fn()
              .mockRejectedValue(new PackageNotFoundError("shell-lib; echo injected")),
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
        "shell-lib; echo injected",
        "--no-scan",
        "--json",
      ]);

      const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(out.nextSteps[0]).toBe("ai-trust check 'shell-lib; echo injected'");
    });
  });

  describe("a <name>@<version> target is looked up in the registry by its name", () => {
    function stderrText(): string {
      return consoleErrSpy.mock.calls
        .map((args) => args.join(" "))
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "");
    }

    it("--no-scan asks about the package and notes that the answer is not for the version", async () => {
      const mockCheckTrust = vi.fn().mockResolvedValue({
        name: "my-pkg",
        found: true,
        verdict: "safe",
        trustLevel: 3,
        packageType: "mcp_server",
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
      await program.parseAsync(["node", "test", "check", "my-pkg@1.2.3", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("my-pkg", undefined);
      expect(stderrText()).toContain(
        "Note: the registry's answer is for the package my-pkg, not for version 1.2.3."
      );
      expect(formatCheckResult).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it("the default check asks about the package, and a registry library is not scanned", async () => {
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
      await program.parseAsync(["node", "test", "check", "express@4.18.0"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("express", undefined);
      expect(stderrText()).toContain(
        "Note: the registry's answer is for the package express, not for version 4.18.0."
      );
      expect(scanPackage).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it("a registry miss names the target as typed and prints no note", async () => {
      const mockCheckTrust = vi
        .fn()
        .mockRejectedValue(new PackageNotFoundError("@scope/my-pkg"));
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
      await program.parseAsync(["node", "test", "check", "@scope/my-pkg@2.0.0", "--no-scan"]);

      expect(mockCheckTrust).toHaveBeenCalledWith("@scope/my-pkg", undefined);
      expect(formatNotFound).toHaveBeenCalledWith(
        expect.objectContaining({ pkg: "@scope/my-pkg@2.0.0", ecosystem: "npm" })
      );
      expect(stderrText()).not.toContain("Note:");
      expect(process.exitCode).toBe(2);
    });

    describe("the registry's score beside a scan of a version (#224)", () => {
      const NOTE = "Note: the registry's answer is for the package my-pkg, not for version 1.0.0.";

      /** The registry scores my-pkg `trustScore` from a completed scan. */
      function registryScores(trustScore: number) {
        const answer = {
          name: "my-pkg",
          found: true,
          trustLevel: 1,
          trustScore,
          verdict: "warning",
          packageType: "mcp_server",
          scanStatus: "completed",
        };
        vi.mocked(RegistryClient).mockImplementation(function () {
          return { checkTrust: vi.fn().mockResolvedValue(answer), publishScan: vi.fn() } as any;
        });
        return answer;
      }

      /** The scan of `packageName` reads one file and scores 100/100. */
      function scanScores100(packageName: string) {
        vi.mocked(isHmaAvailable).mockResolvedValue(true);
        vi.mocked(scanPackage).mockResolvedValue({
          packageName,
          packageVersion: "1.0.0",
          scan: {
            score: 100,
            maxScore: 100,
            findings: [],
            projectType: "mcp",
            timestamp: "2026-10-18T00:00:00Z",
            filesExamined: 1,
          },
          trustScore: 1,
          trustLevel: 3,
          verdict: "safe",
        });
      }

      it("prints the note before a scan output that sets the registry's score beside the scan's", async () => {
        const answer = registryScores(0.2);
        scanScores100("my-pkg@1.0.0");

        await createProgram().parseAsync(["node", "test", "check", "my-pkg@1.0.0", "--no-deep"]);

        expect(formatScanResult).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ registry: answer }),
        );
        const note = consoleErrSpy.mock.calls.findIndex((args) => String(args[0]).includes(NOTE));
        const output = consoleSpy.mock.calls.findIndex((args) => args[0] === "formatted-scan-result");
        expect(note).toBeGreaterThanOrEqual(0);
        expect(output).toBeGreaterThanOrEqual(0);
        expect(consoleErrSpy.mock.invocationCallOrder[note]).toBeLessThan(
          consoleSpy.mock.invocationCallOrder[output],
        );
        expect(process.exitCode).toBeUndefined();
      });

      it("prints no note when the scores are within 20 points, so the scan output shows no registry score", async () => {
        registryScores(0.9);
        scanScores100("my-pkg@1.0.0");

        await createProgram().parseAsync(["node", "test", "check", "my-pkg@1.0.0", "--no-deep"]);

        expect(formatScanResult).toHaveBeenCalled();
        expect(stderrText()).not.toContain("Note:");
      });

      it("prints no note with --json, whose scan document carries no registry answer", async () => {
        registryScores(0.2);
        scanScores100("my-pkg@1.0.0");

        await createProgram().parseAsync(["node", "test", "--json", "check", "my-pkg@1.0.0", "--no-deep"]);

        expect(formatScanResult).not.toHaveBeenCalled();
        expect(stderrText()).not.toContain("Note:");
      });

      it("prints no note for a target without a version", async () => {
        registryScores(0.2);
        scanScores100("my-pkg");

        await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-deep"]);

        expect(formatScanResult).toHaveBeenCalled();
        expect(stderrText()).not.toContain("Note:");
      });
    });

    describe("the library list is consulted with the package name (#224)", () => {
      function stdoutText(): string {
        return consoleSpy.mock.calls
          .map((args) => args.join(" "))
          .join("\n")
          .replace(/\x1b\[[0-9;]*m/g, "");
      }

      function registryHasNoData(name: string) {
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError(name)),
            publishScan: vi.fn(),
          } as any;
        });
      }

      it("--no-scan gives <name>@<version> the by-name out-of-scope notice that <name> gets, and exits 0", async () => {
        registryHasNoData("express");

        await createProgram().parseAsync(["node", "test", "check", "express@4.18.0", "--no-scan"]);

        expect(stdoutText()).toContain("express  library (by name — no registry data)");
        expect(stdoutText()).toContain("npx hackmyagent check express");
        expect(formatNotFound).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });

      it("--no-scan --json names the package the list matched", async () => {
        registryHasNoData("express");

        await createProgram().parseAsync(["node", "test", "--json", "check", "express@4.18.0", "--no-scan"]);

        expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({
          name: "express",
          ecosystem: "npm",
          found: false,
          outOfScope: true,
          scored: false,
          outOfScopeReason: "recognized as general-purpose library by name (no registry data)",
          nextSteps: ["npx hackmyagent check express"],
        });
        expect(process.exitCode).toBeUndefined();
      });

      it("--no-scan shows a registry answer without a package type as a library when the package name is on the list", async () => {
        const mockCheckTrust = vi.fn().mockResolvedValue({
          name: "express",
          found: true,
          verdict: "passed",
          trustLevel: 3,
        });
        vi.mocked(RegistryClient).mockImplementation(function () {
          return { checkTrust: mockCheckTrust, publishScan: vi.fn() } as any;
        });

        await createProgram().parseAsync(["node", "test", "check", "express@4.18.0", "--no-scan"]);

        expect(stderrText()).toContain(
          "Note: the registry's answer is for the package express, not for version 4.18.0."
        );
        expect(stdoutText()).toContain("express  library (registry-classified)");
        expect(formatCheckResult).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });
    });

    it("pip:<name>@<version> downloads that release of the PyPI package (#224)", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("my-py")),
          publishScan: vi.fn(),
        } as any;
      });
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "my-py@2.0.0",
        packageVersion: "2.0.0",
        requestedVersion: "2.0.0",
        scan: {
          score: 100,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-10-18T00:00:00Z",
        },
        trustScore: 1,
        trustLevel: 3,
        verdict: "safe",
      });

      await createProgram().parseAsync(["node", "test", "check", "pip:my-py@2.0.0", "--no-contribute"]);

      expect(scanPackage).toHaveBeenCalledWith("my-py", {
        deep: true,
        ecosystem: "pypi",
        version: "2.0.0",
      });
      expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("Scanning my-py@2.0.0..."));
      expect(formatScanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "my-py@2.0.0" }),
        expect.objectContaining({ ecosystem: "pypi" }),
      );
      expect(process.exitCode).toBeUndefined();
    });

    describe("skill: and mcp: ask for the narrative of <name> at <version>", () => {
      /** The one narrative the registry holds: my-skill at version 1.0.0. */
      const NARRATIVE = {
        artifactType: "skill",
        packageName: "my-skill",
        packageVersion: "1.0.0",
        schemaVersion: 1,
        generatedAt: "2026-10-01T00:00:00Z",
        summary: "A skill this test reads.",
        hardcodedSecrets: { detected: [], scanCovered: true },
        skill: { skillName: "my-skill" },
        verdictReasoning: [],
        nextSteps: [],
      };
      let narrativeRequests: URL[];

      beforeEach(() => {
        narrativeRequests = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname !== "/api/v1/trust/narrative") {
              throw new Error(`unexpected request: ${url.href}`);
            }
            narrativeRequests.push(url);
            const held =
              url.searchParams.get("type") === "skill" &&
              url.searchParams.get("name") === "my-skill" &&
              url.searchParams.get("version") === "1.0.0";
            return held
              ? new Response(JSON.stringify(NARRATIVE), { status: 200 })
              : new Response(JSON.stringify({ error: "narrative_not_available" }), { status: 404 });
          })
        );
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      function mockTrust(answer: Record<string, unknown>) {
        const mockCheckTrust = vi.fn().mockResolvedValue(answer);
        vi.mocked(RegistryClient).mockImplementation(
          function () {
            return {
              checkTrust: mockCheckTrust,
              batchQuery: vi.fn(),
              publishScan: vi.fn(),
            } as any;
          }
        );
        return mockCheckTrust;
      }

      function stdoutText(): string {
        return consoleSpy.mock.calls
          .map((args) => args.join(" "))
          .join("\n")
          .replace(/\x1b\[[0-9;]*m/g, "");
      }

      it("skill:<name>@<version> shows the narrative the registry holds for that version", async () => {
        const mockCheckTrust = mockTrust({
          name: "my-skill",
          found: true,
          verdict: "passed",
          trustLevel: 3,
          trustScore: 0.9,
          scanStatus: "completed",
        });

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "skill:my-skill@1.0.0", "--no-scan"]);

        expect(narrativeRequests).toHaveLength(1);
        expect(narrativeRequests[0].searchParams.get("type")).toBe("skill");
        expect(narrativeRequests[0].searchParams.get("name")).toBe("my-skill");
        expect(narrativeRequests[0].searchParams.get("version")).toBe("1.0.0");
        // The block's own trust lookup asks about the package name too.
        expect(mockCheckTrust).toHaveBeenCalledTimes(1);
        expect(mockCheckTrust).toHaveBeenCalledWith("my-skill");
        expect(stdoutText()).toContain("my-skill");
        expect(stdoutText()).toContain("Latest: 1.0.0");
        expect(formatCheckResult).not.toHaveBeenCalled();
        expect(stderrText()).not.toContain("Note:");
        expect(process.exitCode).toBeUndefined();
      });

      it("mcp:<name>@<version> with no narrative for that version checks the package <name>", async () => {
        const mockCheckTrust = mockTrust({
          name: "my-tool",
          found: true,
          verdict: "safe",
          trustLevel: 3,
          packageType: "mcp_server",
        });

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "mcp:my-tool@1.2.3", "--no-scan"]);

        expect(narrativeRequests).toHaveLength(1);
        expect(narrativeRequests[0].searchParams.get("type")).toBe("mcp");
        expect(narrativeRequests[0].searchParams.get("name")).toBe("my-tool");
        expect(narrativeRequests[0].searchParams.get("version")).toBe("1.2.3");
        expect(mockCheckTrust).toHaveBeenCalledWith("my-tool", undefined);
        expect(stderrText()).toContain(
          "Note: the registry's answer is for the package my-tool, not for version 1.2.3."
        );
        expect(formatCheckResult).toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });

      it("skill:<name> with no version asks for the latest narrative of <name>", async () => {
        mockTrust({
          name: "my-skill",
          found: true,
          verdict: "safe",
          trustLevel: 3,
          packageType: "mcp_server",
        });

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "skill:my-skill", "--no-scan"]);

        expect(narrativeRequests).toHaveLength(1);
        expect(narrativeRequests[0].searchParams.get("name")).toBe("my-skill");
        expect(narrativeRequests[0].searchParams.get("version")).toBe("latest");
        expect(stderrText()).not.toContain("Note:");
      });
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

    it("hands the registry's answer to the scan output, so it can set the two scores side by side", async () => {
      const answer = {
        name: "@modelcontextprotocol/server-filesystem",
        found: true,
        trustLevel: 3,
        trustScore: 0.79,
        verdict: "passed",
        packageType: "mcp_server",
        scanStatus: "warnings",
      };
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockResolvedValue(answer),
          publishScan: vi.fn(),
        } as any;
      });
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "@modelcontextprotocol/server-filesystem",
        scan: {
          score: 100,
          maxScore: 100,
          findings: [],
          projectType: "mcp",
          timestamp: "2026-10-16T00:00:00Z",
        },
        trustScore: 1,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "check", "@modelcontextprotocol/server-filesystem", "--no-deep",
      ]);

      expect(formatScanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "@modelcontextprotocol/server-filesystem" }),
        expect.objectContaining({ remote: true, ecosystem: "npm", registry: answer }),
      );
    });

    it("hands no registry answer to the scan output when the registry has no such package", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockResolvedValue({
            name: "my-pkg",
            found: false,
            trustLevel: 0,
            trustScore: 0,
            verdict: "unknown",
          }),
          publishScan: vi.fn(),
        } as any;
      });
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "my-pkg",
        scan: {
          score: 90,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-10-16T00:00:00Z",
        },
        trustScore: 0.9,
        trustLevel: 3,
        verdict: "safe",
      });

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg"]);

      expect(formatScanResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ remote: true, ecosystem: "npm" }),
      );
      expect(vi.mocked(formatScanResult).mock.calls[0][1]?.registry).toBeUndefined();
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
      expect(contribute.scanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "server-py", ecosystem: "pypi", packageVersion: "0.9.1" })
      );
      expect(mockPublishScan).toHaveBeenCalledOnce();
      expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
        name: "server-py",
        ecosystem: "pypi",
      });
    });

    it("scans a <name>@<version> target at that version and contributes it under the package name", async () => {
      const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("my-pkg")),
            publishScan: mockPublishScan,
          } as any;
        }
      );
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanPackage).mockResolvedValue({
        packageName: "my-pkg@1.2.3",
        packageVersion: "1.2.3",
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
      await program.parseAsync(["node", "test", "check", "my-pkg@1.2.3", "--contribute"]);

      expect(scanPackage).toHaveBeenCalledWith("my-pkg", {
        deep: true,
        ecosystem: "npm",
        version: "1.2.3",
      });
      expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("Scanning my-pkg@1.2.3..."));
      expect(process.exitCode).toBeUndefined();
      expect(sendScanPing).toHaveBeenCalledWith(
        "my-pkg", "safe", 90, "https://api.test.com", "npm"
      );
      expect(contribute.scanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "my-pkg", ecosystem: "npm", packageVersion: "1.2.3" })
      );
      expect(mockPublishScan).toHaveBeenCalledOnce();
      expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
        name: "my-pkg",
        version: "1.2.3",
        ecosystem: "npm",
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

    // What scannerNodeVersionProblem() returns on Node.js 20.18.3.
    const nodeVersionProblem =
      "The hackmyagent version ai-trust pins loads an ES module with require(), which Node.js 20.18.3 does not do (ERR_REQUIRE_ESM). Run ai-trust on Node.js 20.19.0 or a later 20.x release, or on 22.12.0 or later.";

    it("names the Node.js version, not a reinstall, when the scanner cannot load on this Node.js", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(false);
      vi.mocked(scannerNodeVersionProblem).mockReturnValueOnce(nodeVersionProblem);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "my-pkg"]);

      expect(process.exitCode).toBe(1);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        `HMA (HackMyAgent) is required for scanning, and it could not be started. ${nodeVersionProblem}`
      );
      expect(consoleErrSpy).not.toHaveBeenCalledWith(expect.stringContaining("Reinstall"));
      expect(consoleErrSpy).not.toHaveBeenCalledWith("  cd /work/project && npm install");
      expect(scanPackage).not.toHaveBeenCalled();
    });

    it("check --scan-path names the Node.js version, not a reinstall, and exits 2 when the scanner cannot load on this Node.js", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValue(false);
      vi.mocked(scannerNodeVersionProblem).mockReturnValueOnce(nodeVersionProblem);
      let exitCode: number | undefined;
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        exitCode = code;
        throw new Error("process.exit");
      }) as never);
      try {
        await createProgram()
          .parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep"])
          .catch(() => {});
      } finally {
        exit.mockRestore();
      }

      expect(exitCode).toBe(2);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining(`error: HMA could not be started. ${nodeVersionProblem}`)
      );
      expect(consoleErrSpy).not.toHaveBeenCalledWith(expect.stringContaining("Reinstall"));
      expect(scanLocalPath).not.toHaveBeenCalled();
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

    // The npm downloader refuses a name that is not an npm registry package
    // name before npm runs. For the git-style shorthand `<owner>/<repo>` that
    // refusal took the place of npm's `code 128`, which `check` translated
    // into the not-found block with a "did you mean @owner/repo" hint and
    // exit 2; the refusal must give the same result. These tests go through
    // the real translateDownloadError from @opena2a/check-core.
    describe("downloader refusal of a name that is not an npm package name", () => {
      const refusal = (name: string) =>
        new Error(
          `Failed to download "${name}": "${name}" is not a valid npm package name.`
        );

      beforeEach(() => {
        vi.mocked(RegistryClient).mockImplementation(
          function () {
            return {
              checkTrust: vi
                .fn()
                .mockRejectedValue(new PackageNotFoundError("anthropic/code-review")),
              batchQuery: vi.fn(),
              publishScan: vi.fn(),
            } as any;
          }
        );
        vi.mocked(isHmaAvailable).mockResolvedValue(true);
      });

      it("check <owner>/<repo> keeps the not-found block, the @owner/repo suggestion and exit 2", async () => {
        vi.mocked(scanPackage).mockRejectedValue(refusal("anthropic/code-review"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "anthropic/code-review"]);

        expect(process.exitCode).toBe(2);
        expect(formatNotFound).toHaveBeenCalledWith(
          expect.objectContaining({
            pkg: "anthropic/code-review",
            ecosystem: "npm",
            errorHint: expect.stringContaining('did you mean "@anthropic/code-review"'),
            suggestions: ["@anthropic/code-review"],
          })
        );
        expect(consoleErrSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("is not a valid npm package name")
        );
      });

      it("check <owner>/<repo> --json carries errorHint and suggestions and exits 2", async () => {
        vi.mocked(scanPackage).mockRejectedValue(refusal("anthropic/code-review"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "anthropic/code-review", "--json"]);

        expect(process.exitCode).toBe(2);
        const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
        expect(out.suggestions).toEqual(["@anthropic/code-review"]);
        expect(out.errorHint).toContain('did you mean "@anthropic/code-review"');
      });

      it("check <name>@<version> passes the name and the version apart; a version the downloader refuses is a plain error, exit 1", async () => {
        const message =
          'Failed to download "no-such-pkg@npm:other-pkg": "npm:other-pkg" is not a version or tag ai-trust can download. Give an exact version, as in no-such-pkg@1.2.3, or a tag, as in no-such-pkg@latest.';
        vi.mocked(scanPackage).mockRejectedValue(new Error(message));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "no-such-pkg@npm:other-pkg"]);

        expect(scanPackage).toHaveBeenCalledWith(
          "no-such-pkg",
          expect.objectContaining({ ecosystem: "npm", version: "npm:other-pkg" })
        );
        expect(process.exitCode).toBe(1);
        expect(formatNotFound).not.toHaveBeenCalled();
        expect(consoleErrSpy).toHaveBeenCalledWith(`Error: ${message}`);
      });
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
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "ping-pkg"]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });

    it("pings when --contribute is passed", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "check", "ping-pkg", "--contribute",
      ]);

      expect(sendScanPing).toHaveBeenCalledWith(
        "ping-pkg", "safe", 90, "https://api.test.com", "npm"
      );
    });

    it("pings when contribution is enabled via persisted config, with no flag", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(true);

      const program = createProgram();
      await program.parseAsync(["node", "test", "check", "ping-pkg"]);

      expect(sendScanPing).toHaveBeenCalled();
    });

    it("--no-contribute is a registered option and does not error", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      // Regression for the exact reported bug: this used to throw
      // "error: unknown option '--no-contribute'" because the flag was
      // advertised in --help but never registered with Commander.
      await expect(
        program.parseAsync(["node", "test", "check", "ping-pkg", "--no-contribute"])
      ).resolves.not.toThrow();
    });

    it("--no-contribute overrides a persisted opt-in and suppresses the ping", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(true);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "check", "ping-pkg", "--no-contribute",
      ]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });
  });

  describe("--all prints every finding", () => {
    const scanned: ScanResult = {
      packageName: "fixture",
      scan: {
        score: 20,
        maxScore: 100,
        findings: [],
        projectType: "repo",
        timestamp: "2026-03-14T00:00:00Z",
      },
      trustScore: 0.2,
      trustLevel: 0,
      verdict: "blocked",
    };

    beforeEach(() => {
      vi.stubEnv("AI_TRUST_CLI_PREFIX", "");
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("is a registered option that check --scan-path passes to the formatter, with the command it re-runs", async () => {
      vi.mocked(scanLocalPath).mockResolvedValue({ ...scanned });
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      try {
        await createProgram().parseAsync([
          "node", "test", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep", "--all",
        ]);
      } finally {
        exit.mockRestore();
      }

      expect(formatScanResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          remote: false,
          all: true,
          rerunCommand: "ai-trust check fixture --scan-path /tmp/fixture --no-deep",
        }),
      );
    });

    it("without --all, a downloaded package's result cites the arguments it was checked with", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("my-pkg")),
          publishScan: vi.fn(),
        } as any;
      });
      vi.mocked(scanPackage).mockResolvedValue({ ...scanned, packageName: "my-pkg" });

      await createProgram().parseAsync([
        "node", "test", "check", "pip:my-pkg", "--registry-url", "https://registry.example.test",
        "--analm", "--no-contribute",
      ]);

      expect(formatScanResult).toHaveBeenCalledWith(expect.anything(), {
        remote: true,
        ecosystem: "pypi",
        all: false,
        rerunCommand:
          "ai-trust check pip:my-pkg --analm --no-contribute --registry-url https://registry.example.test",
      });
    });

    it("is listed in check --help", () => {
      const help = createProgram()
        .commands.find((c) => c.name() === "check")!
        .helpInformation();
      expect(help).toMatch(/--all\s+print every finding/);
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

      expect(contribute.scanResult).toHaveBeenCalled();
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
      expect(contribute.scanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "scan-me", ecosystem: "npm", packageVersion: "1.2.3" })
      );
    });

    it("contributes silently once consent is given (no per-scan contribution line)", async () => {
      vi.mocked(contribute.flush).mockResolvedValue(true);
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
        vi.mocked(contribute.flush).mockResolvedValue(false);
      }

      // The contribution still happens...
      expect(contribute.scanResult).toHaveBeenCalled();
      expect(contribute.flush).toHaveBeenCalled();
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
      vi.mocked(contribute.flush).mockResolvedValue(false);
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

    describe("the hackmyagent hint keeps the pip: prefix of a PyPI target (#132)", () => {
      // The out-of-scope notice goes to stdout (#218).
      function stdoutText(): string {
        return consoleSpy.mock.calls
          .map((args) => args.join(" "))
          .join("\n")
          .replace(/\x1b\[[0-9;]*m/g, "");
      }

      function mockRegistry(checkTrust: ReturnType<typeof vi.fn>): void {
        vi.mocked(RegistryClient).mockImplementation(
          function () {
            return {
              checkTrust,
              batchQuery: vi.fn(),
              publishScan: vi.fn(),
            } as any;
          }
        );
      }

      const registryLibrary = (name: string) =>
        vi.fn().mockResolvedValue({
          name,
          found: true,
          verdict: "listed",
          trustLevel: 2,
          trustScore: 0.67,
          packageType: "library",
        });

      it("registry-classified library (--no-scan) cites npx hackmyagent check pip:<name>", async () => {
        mockRegistry(registryLibrary("requests"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "pip:requests", "--no-scan"]);

        expect(stdoutText()).toMatch(/^ {4}npx hackmyagent check pip:requests$/m);
        expect(process.exitCode).toBeUndefined();
      });

      it("registry-classified library (--no-scan --json) lists npx hackmyagent check pip:<name>", async () => {
        mockRegistry(registryLibrary("requests"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "--json", "check", "pip:requests", "--no-scan"]);

        const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
        expect(out.nextSteps).toEqual(["npx hackmyagent check pip:requests"]);
      });

      it("registry-classified library on the default scan path cites npx hackmyagent check pip:<name>", async () => {
        mockRegistry(registryLibrary("requests"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "pip:requests"]);

        expect(scanPackage).not.toHaveBeenCalled();
        expect(stdoutText()).toMatch(/^ {4}npx hackmyagent check pip:requests$/m);
      });

      it("library by name with no registry data (--no-scan) cites npx hackmyagent check pip:<name>", async () => {
        mockRegistry(vi.fn().mockRejectedValue(new PackageNotFoundError("not in registry")));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "pip:requests", "--no-scan"]);

        expect(stdoutText()).toMatch(/^ {4}npx hackmyagent check pip:requests$/m);
        expect(process.exitCode).toBeUndefined();
      });

      it("library by name with no registry data (--no-scan --json) lists npx hackmyagent check pip:<name>", async () => {
        mockRegistry(vi.fn().mockRejectedValue(new PackageNotFoundError("not in registry")));

        const program = createProgram();
        await program.parseAsync(["node", "test", "--json", "check", "pip:requests", "--no-scan"]);

        const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
        expect(out.nextSteps).toEqual(["npx hackmyagent check pip:requests"]);
      });

      it("an npm target still cites the bare name", async () => {
        mockRegistry(registryLibrary("express"));

        const program = createProgram();
        await program.parseAsync(["node", "test", "check", "express", "--no-scan"]);

        expect(stdoutText()).toMatch(/^ {4}npx hackmyagent check express$/m);
      });
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

    it("describes --scan-path by what it does for the user, not by the test corpus it serves (#177)", () => {
      const help = checkHelp().replace(/\s+/g, " ");
      expect(help).not.toContain("adversarial-corpus");
      expect(help).not.toContain("npm-pack");
      expect(help).toContain(
        "--scan-path <dir> scan a local directory instead of downloading a package; <name> labels the result",
      );
    });
  });

  describe("an empty target names no package (#177)", () => {
    for (const [label, target] of [
      ["empty", ""],
      ["spaces only", "   "],
    ] as const) {
      for (const flags of [[], ["--no-scan"]]) {
        it(`${label} target with ${flags.join(" ") || "no flag"}: a usage error before any lookup or scan`, async () => {
          await createProgram().parseAsync(["node", "test", "check", target, ...flags]);

          expect(consoleErrSpy.mock.calls.map((c) => c.join(" "))).toEqual([
            "Error: No package name given. Usage: ai-trust check <package>",
          ]);
          expect(consoleSpy).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
          expect(RegistryClient).not.toHaveBeenCalled();
          expect(isHmaAvailable).not.toHaveBeenCalled();
          expect(scanPackage).not.toHaveBeenCalled();
        });
      }
    }
  });

  // A bare skill: or mcp: is the same usage error as a bare pip: (#193), not a
  // narrative request and a download of a package named "skill:" or "mcp:".
  describe("skill: or mcp: with nothing after names nothing to check (#193)", () => {
    for (const [target, error] of [
      ["skill:", 'Error: No package name after "skill:". Usage: ai-trust check skill:<name>'],
      ["mcp:", 'Error: No package name after "mcp:". Usage: ai-trust check mcp:<name>'],
      [" skill: ", 'Error: No package name after "skill:". Usage: ai-trust check skill:<name>'],
    ] as const) {
      for (const flags of [[], ["--no-scan"]]) {
        it(`check ${JSON.stringify(target)} ${flags.join(" ") || "with no flag"}: a usage error before any lookup or scan`, async () => {
          await createProgram().parseAsync(["node", "test", "check", target, ...flags]);

          expect(consoleErrSpy.mock.calls.map((c) => c.join(" "))).toEqual([error]);
          expect(consoleSpy).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
          expect(RegistryClient).not.toHaveBeenCalled();
          expect(isHmaAvailable).not.toHaveBeenCalled();
          expect(scanPackage).not.toHaveBeenCalled();
        });
      }
    }
  });

  // With --json the usage error is one JSON object on stdout and nothing on
  // stderr, as for a --registry-url usage error.
  describe("a target that names no package, with --json (#183)", () => {
    for (const [target, error] of [
      ["", "No package name given. Usage: ai-trust check <package>"],
      ["   ", "No package name given. Usage: ai-trust check <package>"],
      ["pip:", 'No package name after "pip:". Usage: ai-trust check pip:<package>'],
      ["npm:", 'No package name after "npm:". Usage: ai-trust check npm:<package>'],
      ["skill:", 'No package name after "skill:". Usage: ai-trust check skill:<name>'],
      ["mcp:", 'No package name after "mcp:". Usage: ai-trust check mcp:<name>'],
    ] as const) {
      for (const flags of [["--json"], ["--no-scan", "--json"]]) {
        it(`check ${JSON.stringify(target)} ${flags.join(" ")}: {"error"} on stdout, exit 1`, async () => {
          await createProgram().parseAsync(["node", "test", "check", target, ...flags]);

          expect(consoleSpy.mock.calls).toHaveLength(1);
          expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({ error });
          expect(consoleErrSpy).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
          expect(RegistryClient).not.toHaveBeenCalled();
          expect(isHmaAvailable).not.toHaveBeenCalled();
          expect(scanPackage).not.toHaveBeenCalled();
        });
      }
    }
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

  it('Exit-code table row "Nothing to scan" gives the code check --scan-path sets when the scanner read 0 files', async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockResolvedValue({
      packageName: "fixture",
      scan: {
        score: 93,
        maxScore: 100,
        checksEvaluated: 22,
        filesExamined: 0,
        findings: [],
        projectType: "library",
        timestamp: "2026-10-16T00:00:00Z",
      },
      trustScore: 0.93,
      trustLevel: 3,
      verdict: "safe",
    });

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/empty"]);

    const documented = documentedExitCodes().get("Nothing to scan");
    expect(documented, 'docs/commands.md exit-code table has no "Nothing to scan" row').toBeDefined();
    expect(documented).toBe(2);
    expect(process.exitCode ?? 0).toBe(documented);
    expect(formatScanResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scanPath: "/tmp/empty" }),
    );
  });

  it("check --scan-path exits 0 for a scan that read files, whatever the verdict", async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockResolvedValue({
      packageName: "fixture",
      scan: {
        score: 93,
        maxScore: 100,
        checksEvaluated: 22,
        filesExamined: 4,
        findings: [],
        projectType: "library",
        timestamp: "2026-10-16T00:00:00Z",
      },
      trustScore: 0.93,
      trustLevel: 3,
      verdict: "safe",
    });

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/project"]);

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("check --scan-path exits 0 for a scan that read 0 files because the scanner found files it could not read", async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockResolvedValue({
      packageName: "fixture",
      scan: {
        score: 69,
        maxScore: 100,
        checksEvaluated: 22,
        filesExamined: 0,
        unreadableInputs: 1,
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
        projectType: "library",
        timestamp: "2026-10-16T00:00:00Z",
      },
      trustScore: 0.69,
      trustLevel: 2,
      verdict: "warning",
    });

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/unreadable"]);

    expect(process.exitCode ?? 0).toBe(0);
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

// #178: `check --analm` printed the same output as `check` when the scanner's
// analyst layer did not run. Every path below prints one line saying whether
// it ran or why not.
describe("check --analm says whether the analyst layer ran", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  const NOT_RUN =
    "AnaLM: the analyst layer did not run; the scanner runs it only when a NanoMind analyst daemon answers on this machine. Set one up: npx hackmyagent nanomind setup";

  function scanResult(analystLayer?: AnalystLayerStatus) {
    return {
      packageName: "fixture",
      scan: {
        score: 90,
        maxScore: 100,
        findings: [],
        projectType: "library",
        timestamp: "2026-10-16T00:00:00Z",
        ...(analystLayer ? { analystLayer } : {}),
      },
      trustScore: 0.9,
      trustLevel: 3,
      verdict: "safe" as const,
    };
  }

  function analmLines(): string[] {
    return consoleErrSpy.mock.calls
      .map((args) => args.join(" ").replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((line) => line.startsWith("AnaLM:"));
  }

  function registry(checkTrust: () => Promise<unknown>): void {
    vi.mocked(RegistryClient).mockImplementation(function () {
      return { checkTrust: vi.fn(checkTrust), batchQuery: vi.fn(), publishScan: vi.fn() } as any;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it("--scan-path --analm says the analyst layer did not run when the scanner reported no analyst output", async () => {
    vi.mocked(scanLocalPath).mockResolvedValue(
      scanResult({ ran: false, reason: "no-analyst-output" }),
    );

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/fixture", "--analm"]);

    expect(scanLocalPath).toHaveBeenCalledWith("/tmp/fixture", { deep: true, analm: true });
    expect(analmLines()).toEqual([NOT_RUN]);
  });

  it("--scan-path --analm --json keeps stdout one JSON document and puts the note on stderr", async () => {
    vi.mocked(scanLocalPath).mockResolvedValue(
      scanResult({ ran: true, findingsAnalyzed: 0, sweep: { swept: 2, nullVerdicts: 0 } }),
    );

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "fixture", "--scan-path", "/tmp/fixture", "--analm",
    ]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(consoleSpy.mock.calls[0][0]))).not.toThrow();
    expect(analmLines()).toEqual(["AnaLM: the analyst layer ran (0 findings analyzed, 2 files checked)."]);
  });

  it("--scan-path without --analm prints no AnaLM line", async () => {
    vi.mocked(scanLocalPath).mockResolvedValue(scanResult());

    await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/tmp/fixture"]);

    expect(analmLines()).toEqual([]);
  });

  it("a downloaded package scanned with --analm --no-deep names --no-deep", async () => {
    registry(async () => {
      throw new PackageNotFoundError("my-pkg");
    });
    vi.mocked(scanPackage).mockResolvedValue(scanResult({ ran: false, reason: "static-only" }));

    await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--analm", "--no-deep"]);

    expect(scanPackage).toHaveBeenCalledWith("my-pkg", { deep: false, analm: true, ecosystem: "npm" });
    expect(analmLines()).toEqual([
      "AnaLM: the analyst layer did not run: --no-deep turns off the scanner's semantic layer, which the analyst runs inside.",
    ]);
  });

  it("--no-scan --analm says no local scan ran", async () => {
    registry(async () => ({ name: "some-mcp", found: true, verdict: "safe", trustLevel: 3, packageType: "mcp_server" }));

    await createProgram().parseAsync(["node", "test", "check", "some-mcp", "--no-scan", "--analm"]);

    expect(analmLines()).toEqual([
      "AnaLM: the analyst layer did not run: --no-scan skips the local scan it runs in.",
    ]);
  });

  it("a registry library checked with --analm says no local scan ran", async () => {
    registry(async () => ({ name: "express", found: true, verdict: "safe", trustLevel: 3, packageType: "library" }));

    await createProgram().parseAsync(["node", "test", "check", "express", "--analm"]);

    expect(scanPackage).not.toHaveBeenCalled();
    expect(analmLines()).toEqual([
      "AnaLM: the analyst layer did not run: the registry lists this package as a library, so no local scan ran.",
    ]);
  });
});

// #226: when the scanner ended without a report, check --scan-path printed
// the fix for a directory that does not exist or cannot be read, although the
// directory existed and was readable.
describe("check --scan-path prints the fix for the failure it hit", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  const DIRECTORY_FIX = "Fix: pass --scan-path to a directory that exists and is readable.";

  function stderrLines(): string[] {
    return consoleErrSpy.mock.calls.map((args) =>
      args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""),
    );
  }

  /** Run `check fixture --scan-path <dir> --no-deep`; returns the code it exits with. */
  async function checkScanPath(dir: string): Promise<number | undefined> {
    let exitCode: number | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("process.exit");
    }) as never);
    try {
      await createProgram()
        .parseAsync(["node", "test", "check", "fixture", "--scan-path", dir, "--no-deep"])
        .catch(() => {});
    } finally {
      exit.mockRestore();
    }
    return exitCode;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it("names the scanner and its reinstall, not the directory, when the scanner gives no report", async () => {
    const failure = new HmaScanError(
      "HMA scan failed: Command failed: node hackmyagent/dist/cli.js secure --format json --no-contribute --static-only /tmp/fixture\nscanner crashed\n",
    );
    vi.mocked(scanLocalPath).mockRejectedValue(failure);

    const exitCode = await checkScanPath("/tmp/fixture");

    expect(stderrLines()).toEqual([
      `error: ${failure.message}`,
      "Fix: the scanner produced no readable report. Run it directly: npx hackmyagent secure /tmp/fixture",
      "Or reinstall the hackmyagent copy ai-trust runs: cd /work/project && npm install",
    ]);
    expect(exitCode).toBe(2);
  });

  it("quotes a directory with a space or shell syntax in the scanner command it prints", async () => {
    vi.mocked(scanLocalPath).mockRejectedValue(new HmaScanError("HMA scan failed: No JSON output found from HMA scan"));

    await checkScanPath("/tmp/my fixture; echo injected");

    expect(stderrLines()).toContain(
      "Fix: the scanner produced no readable report. Run it directly: npx hackmyagent secure '/tmp/my fixture; echo injected'",
    );
  });

  it.each([
    ["does not exist", "/nonexistent", "scanLocalPath: /nonexistent could not be read (ENOENT)."],
    ["is a file", "/tmp/fixture.txt", "scanLocalPath: /tmp/fixture.txt is not a directory."],
  ])("names the directory, not the scanner, when the --scan-path target %s", async (_label, dir, message) => {
    vi.mocked(scanLocalPath).mockRejectedValue(new ScanPathError(message));

    const exitCode = await checkScanPath(dir);

    expect(stderrLines()).toEqual([`error: ${message}`, DIRECTORY_FIX]);
    expect(exitCode).toBe(2);
  });

  it("prints an error of another kind alone, with neither fix", async () => {
    const failure = new Error(
      "ai-trust runs the scanner with a new temporary home directory and could not create one in /missing (ENOENT). Point TMPDIR at a directory that exists and that you can write to, for example: export TMPDIR=/tmp",
    );
    vi.mocked(scanLocalPath).mockRejectedValue(failure);

    const exitCode = await checkScanPath("/tmp/fixture");

    expect(stderrLines()).toEqual([`error: ${failure.message}`]);
    expect(exitCode).toBe(2);
  });
});
