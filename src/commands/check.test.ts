/**
 * Tests for the check command logic, including scan-on-demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
// registry's score beside the scan's; notFoundNextSteps is the real list of
// the not-found block's Next Steps, which --no-scan --json prints)
vi.mock("../output/formatter.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../output/formatter.js")>();
  return {
    ecosystemSuffix: real.ecosystemSuffix,
    showsRegistryScore: real.showsRegistryScore,
    notFoundNextSteps: real.notFoundNextSteps,
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
// isContributeEnabled is the library's read of a saved on, which no test
// here saves: a scan shared with --contribute sends its summary through
// submitBatch, and queueScanResult would queue nothing.
vi.mock("@opena2a/contribute", () => ({
  contribute: {
    scanResult: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(false),
  },
  getContributorToken: vi.fn().mockReturnValue("a".repeat(64)),
  isContributeEnabled: vi.fn().mockReturnValue(false),
  submitBatch: vi.fn().mockResolvedValue(true),
}));

import {
  RegistryClient,
  PackageNotFoundError,
  RegistryApiError,
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
import { contribute, submitBatch } from "@opena2a/contribute";

/** The package of each scan summary sent at once, in the order sent. */
function sentSummaryPackages(): unknown[] {
  return vi
    .mocked(submitBatch)
    .mock.calls.flatMap(([batch]) => batch.events.map((event) => event.package));
}

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

    // A failed lookup printed "found": false, which a script reads as a
    // registry miss (#230). Exit 1 stays the signal that the lookup failed.
    it("a failed lookup with --json carries the error and no found field", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockRejectedValue(new Error("Registry network error: fetch failed")),
          batchQuery: vi.fn(),
          publishScan: vi.fn(),
        } as any;
      });

      await createProgram().parseAsync(["node", "test", "check", "any-pkg", "--no-scan", "--json"]);

      expect(consoleSpy.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        name: "any-pkg",
        ecosystem: "npm",
        error: "Registry network error: fetch failed",
      });
      expect(process.exitCode).toBe(1);
    });

    it("a registry client refusal is printed without the client's class name", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi
            .fn()
            .mockRejectedValue(new TypeError("RegistryClient: type contains control characters")),
          batchQuery: vi.fn(),
          publishScan: vi.fn(),
        } as any;
      });

      await createProgram().parseAsync(["node", "test", "check", "any-pkg", "--no-scan"]);

      expect(consoleErrSpy).toHaveBeenCalledWith("Error: Type contains control characters");
      expect(process.exitCode).toBe(1);
    });

    describe("a registry error that quotes a URL with a user name and password (#232)", () => {
      // Placeholder userinfo: the test needs a URL with user:password@ in it.
      const PLANTED_NAME = "FAKE-USER";
      const PLANTED_WORD = "FAKE-PASSWORD";
      const URL_WITH_USERINFO = "http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:9";
      const QUOTED =
        "Registry network error: Request cannot be constructed from a URL that includes credentials: ";
      const QUERY = "/api/v1/trust/query?name=any-pkg&includeProfile=true&includeDeps=true";

      function registryFails(): void {
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new Error(`${QUOTED}${URL_WITH_USERINFO}${QUERY}`)),
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        });
      }

      function printed(): string {
        return [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]
          .map((c) => String(c[0]))
          .join("\n");
      }

      it("prints the error line with [redacted] in place of them", async () => {
        registryFails();
        await createProgram().parseAsync([
          "node", "test", "--registry-url", URL_WITH_USERINFO, "check", "any-pkg", "--no-scan",
        ]);

        expect(consoleErrSpy.mock.calls.map((c) => String(c[0]))).toEqual([
          `Error: ${QUOTED}http://[redacted]@127.0.0.1:9${QUERY}`,
        ]);
        expect(printed()).not.toContain(PLANTED_NAME);
        expect(printed()).not.toContain(PLANTED_WORD);
        expect(process.exitCode).toBe(1);
      });

      it("--json: the error string has [redacted] in place of them", async () => {
        registryFails();
        await createProgram().parseAsync([
          "node", "test", "--json", "--registry-url", URL_WITH_USERINFO, "check", "any-pkg", "--no-scan",
        ]);

        expect(JSON.parse(String(consoleSpy.mock.calls[0][0])).error).toBe(
          `${QUOTED}http://[redacted]@127.0.0.1:9${QUERY}`,
        );
        expect(printed()).not.toContain(PLANTED_NAME);
        expect(printed()).not.toContain(PLANTED_WORD);
        expect(process.exitCode).toBe(1);
      });
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
      // No scan ran, so the block keeps its scan step (#123).
      expect(vi.mocked(formatNotFound).mock.calls[0][0].scanned).toBeUndefined();
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
      // changes nothing because every in-scope package is scanned by default.
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

    it("keeps the pip: prefix in --json nextSteps for a PyPI registry miss (#114)", async () => {
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            checkTrust: vi
              .fn()
              .mockRejectedValue(new PackageNotFoundError("smolagents")),
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
        "pip:smolagents",
        "--no-scan",
        "--json",
      ]);

      expect(process.exitCode).toBe(2);
      const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(out.ecosystem).toBe("pypi");
      // Without the prefix the command checks the npm package of that name.
      expect(out.nextSteps[0]).toBe("ai-trust check pip:smolagents");
    });

    // --json gave a second next step the text output does not print, with a
    // placeholder in it: `npx hackmyagent secure <project-dir>` (#276).
    describe("--json gives the next steps the text output prints (#276)", () => {
      let dir: string;
      let cwdSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ai-trust-not-found-steps-"));
        // The Full project audit step names the file audit reads in the
        // current directory.
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("unknown-pkg")),
            batchQuery: vi.fn(),
            publishScan: vi.fn(),
          } as any;
        });
      });

      afterEach(() => {
        cwdSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      });

      /** The command of each Next Steps line of the text output. */
      async function textNextSteps(): Promise<string[]> {
        const real = await vi.importActual<typeof import("../output/formatter.js")>(
          "../output/formatter.js",
        );
        vi.mocked(formatNotFound).mockImplementationOnce(real.formatNotFound);
        consoleSpy.mockClear();
        await createProgram().parseAsync(["node", "test", "check", "unknown-pkg", "--no-scan"]);
        const lines = consoleSpy.mock.calls
          .map((call) => String(call[0]))
          .join("\n")
          .replace(/\u001b\[[0-9;]*m/g, "")
          .split("\n");
        const start = lines.findIndex((line) => line.includes("Next Steps"));
        return lines
          .slice(start + 1)
          .filter((line) => line.trim() !== "")
          .map((line) => line.trim().split(/ {2,}/).pop() as string);
      }

      async function jsonNextSteps(): Promise<unknown> {
        consoleSpy.mockClear();
        await createProgram().parseAsync([
          "node", "test", "check", "unknown-pkg", "--no-scan", "--json",
        ]);
        return JSON.parse(String(consoleSpy.mock.calls[0][0])).nextSteps;
      }

      it("with no file audit reads in the directory: the scan", async () => {
        expect(await textNextSteps()).toEqual(["ai-trust check unknown-pkg"]);
        expect(await jsonNextSteps()).toEqual(["ai-trust check unknown-pkg"]);
        expect(process.exitCode).toBe(2);
      });

      it("with a package.json in the directory: the scan, then the audit of that file", async () => {
        writeFileSync(join(dir, "package.json"), "{}\n");
        const expected = ["ai-trust check unknown-pkg", "ai-trust audit package.json"];
        expect(await textNextSteps()).toEqual(expected);
        expect(await jsonNextSteps()).toEqual(expected);
      });
    });

    describe("a failed registry lookup names the registry and the scan that runs without it", () => {
      function registryFails(err: Error): ReturnType<typeof vi.fn> {
        const checkTrust = vi.fn().mockRejectedValue(err);
        vi.mocked(RegistryClient).mockImplementation(function () {
          return { checkTrust, batchQuery: vi.fn(), publishScan: vi.fn() } as any;
        });
        return checkTrust;
      }

      function networkError(): RegistryApiError {
        return new RegistryApiError("Registry network error: fetch failed", "network");
      }

      function stderrLines(): string[] {
        return consoleErrSpy.mock.calls.map((c) => String(c[0]));
      }

      afterEach(() => {
        delete process.env.AI_TRUST_CLI_PREFIX;
      });

      it("says the registry did not answer, after the retry, and names check without --no-scan", async () => {
        const checkTrust = registryFails(networkError());
        await createProgram().parseAsync([
          "node", "test", "check", "@modelcontextprotocol/server-filesystem", "--no-scan",
          "--registry-url", "http://127.0.0.1:9",
        ]);

        expect(stderrLines()).toEqual([
          "Error: Registry network error: fetch failed",
          "  The registry at http://127.0.0.1:9 did not answer.",
          "  Next: ai-trust check @modelcontextprotocol/server-filesystem",
        ]);
        expect(checkTrust).toHaveBeenCalledTimes(2);
        expect(process.exitCode).toBe(1);
      });

      it("gives the same lines for a request that timed out twice, after the time both attempts took", async () => {
        registryFails(new RegistryApiError("Registry request timed out after 15000ms", "timeout"));
        await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan"]);

        // A line said before the second attempt that the first timed out, and
        // the error gives the time both took, not the limit of one (#230).
        const lines = stderrLines();
        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe(
          "  The registry at https://api.test.com did not answer within 15000 ms; trying once more."
        );
        expect(lines[1]).toMatch(
          /^Error: Registry request timed out: the registry at https:\/\/api\.test\.com did not answer in \d+(\.\d)? s \(2 attempts of up to 15000 ms each\)$/
        );
        expect(lines.slice(2)).toEqual([
          "  The registry at https://api.test.com did not answer.",
          "  Next: ai-trust check my-pkg",
        ]);
        expect(process.exitCode).toBe(1);
      });

      it("names the status a registry that answered with an error gave", async () => {
        const checkTrust = registryFails(
          new RegistryApiError("Registry API returned 500", "server_error", 500, "{}")
        );
        await createProgram().parseAsync([
          "node", "test", "check", "my-pkg", "--no-scan", "--registry-url", "http://127.0.0.1:8123",
        ]);

        expect(stderrLines()).toEqual([
          "Error: Registry API returned 500",
          "  The registry at http://127.0.0.1:8123 answered 500.",
          "  Next: ai-trust check my-pkg",
        ]);
        expect(checkTrust).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
      });

      it("says the answer was not JSON when the registry answered with a body that does not parse", async () => {
        registryFails(
          new RegistryApiError(
            "Registry returned invalid JSON: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
            "invalid_response",
            200
          )
        );
        await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan"]);

        expect(stderrLines().slice(1)).toEqual([
          "  The registry at https://api.test.com answered 200 with a body that is not JSON.",
          "  Next: ai-trust check my-pkg",
        ]);
        expect(process.exitCode).toBe(1);
      });

      it("keeps the pip: prefix of a PyPI target in the next step", async () => {
        registryFails(networkError());
        await createProgram().parseAsync(["node", "test", "check", "pip:requests", "--no-scan"]);

        expect(stderrLines()[2]).toBe("  Next: ai-trust check pip:requests");
      });

      it("quotes a name with shell syntax in the next step", async () => {
        registryFails(networkError());
        await createProgram().parseAsync([
          "node", "test", "check", "shell-lib; echo injected", "--no-scan",
        ]);

        expect(stderrLines()[2]).toBe("  Next: ai-trust check 'shell-lib; echo injected'");
      });

      it("cites the bundling CLI's command when AI_TRUST_CLI_PREFIX is set", async () => {
        process.env.AI_TRUST_CLI_PREFIX = "opena2a registry";
        registryFails(networkError());
        await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan"]);

        expect(stderrLines()[2]).toBe("  Next: opena2a registry my-pkg");
      });

      it("removes control characters from the registry URL it prints", async () => {
        registryFails(networkError());
        await createProgram().parseAsync([
          "node", "test", "check", "my-pkg", "--no-scan",
          "--registry-url", "http://127.0.0.1:9/\u001b[2J\u0007api",
        ]);

        expect(stderrLines()[1]).toBe("  The registry at http://127.0.0.1:9/[2Japi did not answer.");
      });

      it("adds no registry line for an error the registry client did not raise", async () => {
        registryFails(new Error("network failure"));
        await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan"]);

        expect(stderrLines()).toEqual(["Error: network failure"]);
        expect(process.exitCode).toBe(1);
      });

      it("with --json prints one object on stdout, without found, and nothing on stderr", async () => {
        registryFails(networkError());
        await createProgram().parseAsync([
          "node", "test", "--json", "check", "@modelcontextprotocol/server-filesystem", "--no-scan",
          "--registry-url", "http://127.0.0.1:9",
        ]);

        // Whether the registry has the package is not known, so the object
        // carries no `found: false`, which reads as a miss (#230).
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
          name: "@modelcontextprotocol/server-filesystem",
          error: "Registry network error: fetch failed",
          ecosystem: "npm",
        });
        expect(consoleErrSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      });
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

    // The Next Steps scan lost the version, and the JSON had no field for the
    // stderr note (#230).
    it("--no-scan hands the version to the text output and marks the JSON answer as the package's", async () => {
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockResolvedValue({
            name: "my-pkg",
            found: true,
            verdict: "passed",
            trustLevel: 3,
            packageType: "mcp_server",
          }),
          batchQuery: vi.fn(),
          publishScan: vi.fn(),
        } as any;
      });

      await createProgram().parseAsync(["node", "test", "check", "my-pkg@1.2.3", "--no-scan"]);
      expect(formatCheckResult).toHaveBeenCalledWith(
        expect.objectContaining({ name: "my-pkg" }),
        "npm",
        { version: "1.2.3" },
      );

      await createProgram().parseAsync(["node", "test", "check", "my-pkg@1.2.3", "--no-scan", "--json"]);
      const json = JSON.parse(String(consoleSpy.mock.calls.at(-1)![0]));
      expect(json).toMatchObject({
        name: "my-pkg",
        requestedVersion: "1.2.3",
        answerScope: "package",
        source: "registry",
        found: true,
      });

      await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan", "--json"]);
      const unversioned = JSON.parse(String(consoleSpy.mock.calls.at(-1)![0]));
      expect(unversioned).not.toHaveProperty("requestedVersion");
      expect(unversioned).not.toHaveProperty("answerScope");
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

      it("prints no note with --json, whose scan document marks the registry answer as the package's", async () => {
        registryScores(0.2);
        scanScores100("my-pkg@1.0.0");

        await createProgram().parseAsync(["node", "test", "--json", "check", "my-pkg@1.0.0", "--no-deep"]);

        expect(formatScanResult).not.toHaveBeenCalled();
        expect(stderrText()).not.toContain("Note:");
        // The registry's answer the text sets beside the scan's score (#230).
        const json = JSON.parse(String(consoleSpy.mock.calls.at(-1)![0]));
        expect(json.registry).toEqual({
          verdict: "warning",
          trustLevel: 1,
          trustScore: 0.2,
          scanStatus: "completed",
          answerScope: "package",
        });
        expect(json).not.toHaveProperty("registryError");
      });

      it("--json names a failed registry lookup as registryError beside the scan (#230)", async () => {
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new Error("Registry API returned 500")),
            publishScan: vi.fn(),
          } as any;
        });
        scanScores100("my-pkg");

        await createProgram().parseAsync(["node", "test", "--json", "check", "my-pkg", "--no-deep"]);

        const json = JSON.parse(String(consoleSpy.mock.calls.at(-1)![0]));
        expect(json).toMatchObject({ source: "scan", registryError: "Registry API returned 500" });
        expect(json).not.toHaveProperty("registry");
        expect(stderrText()).toContain(
          "Registry lookup failed (Registry API returned 500); proceeding with local scan.",
        );
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
      expect(sentSummaryPackages()).toEqual([
        { name: "server-py", version: "0.9.1", ecosystem: "pypi" },
      ]);
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
      expect(sentSummaryPackages()).toEqual([
        { name: "my-pkg", version: "1.2.3", ecosystem: "npm" },
      ]);
      expect(mockPublishScan).toHaveBeenCalledOnce();
      expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
        name: "my-pkg",
        version: "1.2.3",
        ecosystem: "npm",
      });
    });

    describe("the published scan (#123)", () => {
      function registryWithout(name: string): ReturnType<typeof vi.fn> {
        const mockPublishScan = vi.fn().mockResolvedValue({ accepted: true });
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError(name)),
            publishScan: mockPublishScan,
          } as any;
        });
        vi.mocked(isHmaAvailable).mockResolvedValue(true);
        return mockPublishScan;
      }

      function scanned(checksEvaluated: number): ScanResult {
        return {
          packageName: "mcp-hello-world",
          packageVersion: "1.0.0",
          scan: {
            score: 100,
            maxScore: 100,
            checksEvaluated,
            filesExamined: 3,
            findings: [],
            projectType: "mcp",
            timestamp: "2026-10-21T00:00:00Z",
          },
          trustScore: 1,
          trustLevel: 3,
          verdict: "safe",
        };
      }

      it("carries the --type the package was checked with", async () => {
        const mockPublishScan = registryWithout("mcp-hello-world");
        vi.mocked(scanPackage).mockResolvedValue(scanned(12));

        await createProgram().parseAsync([
          "node", "test", "check", "mcp-hello-world", "--contribute", "--type", "mcp_server",
        ]);

        expect(mockPublishScan).toHaveBeenCalledOnce();
        expect(mockPublishScan.mock.calls[0][0]).toMatchObject({
          name: "mcp-hello-world",
          type: "mcp_server",
          projectType: "mcp",
        });
      });

      // The terminal prints "No analyzable surfaces — not scored" for a scan
      // that executed no check; the registry would record its 100 as a pass.
      it("is not sent, with no ping and no summary, for a scan that executed no check", async () => {
        const mockPublishScan = registryWithout("mcp-hello-world");
        vi.mocked(scanPackage).mockResolvedValue(scanned(0));

        await createProgram().parseAsync(["node", "test", "check", "mcp-hello-world", "--contribute"]);

        expect(formatScanResult).toHaveBeenCalledOnce();
        expect(mockPublishScan).not.toHaveBeenCalled();
        expect(sendScanPing).not.toHaveBeenCalled();
        expect(submitBatch).not.toHaveBeenCalled();
        expect(contribute.scanResult).not.toHaveBeenCalled();
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
        // `scanned`: the block offers no scan of the package it just
        // tried to download (#123).
        expect(formatNotFound).toHaveBeenCalledWith(
          expect.objectContaining({
            pkg: "anthropic/code-review",
            ecosystem: "npm",
            errorHint: expect.stringContaining('did you mean "@anthropic/code-review"'),
            suggestions: ["@anthropic/code-review"],
            scanned: true,
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

    describe("with a user name and password in --registry-url (#232)", () => {
      // Placeholder userinfo: the test needs a URL with user:password@ in it.
      const PLANTED_NAME = "FAKE-USER";
      const PLANTED_WORD = "FAKE-PASSWORD";
      const URL_WITH_USERINFO = "https://FAKE-USER:FAKE-PASSWORD@registry.example.test";

      function printed(): string {
        return [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]
          .map((c) => String(c[0]))
          .join("\n");
      }

      it("the re-run command cites the registry URL without them", async () => {
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("my-pkg")),
            publishScan: vi.fn(),
          } as any;
        });
        vi.mocked(scanPackage).mockResolvedValue({ ...scanned, packageName: "my-pkg" });

        await createProgram().parseAsync([
          "node", "test", "check", "pip:my-pkg", "--registry-url", URL_WITH_USERINFO, "--no-contribute",
        ]);

        expect(formatScanResult).toHaveBeenCalledWith(expect.anything(), {
          remote: true,
          ecosystem: "pypi",
          all: false,
          rerunCommand:
            "ai-trust check pip:my-pkg --no-contribute --registry-url https://registry.example.test/",
        });
      });

      it("the registry lookup failure line has [redacted] in place of them", async () => {
        const quoted =
          "Registry network error: Request cannot be constructed from a URL that includes credentials: ";
        const query = "/api/v1/trust/query?name=my-pkg&includeProfile=true&includeDeps=true";
        vi.mocked(RegistryClient).mockImplementation(function () {
          return {
            checkTrust: vi.fn().mockRejectedValue(new Error(`${quoted}${URL_WITH_USERINFO}${query}`)),
            publishScan: vi.fn(),
          } as any;
        });
        vi.mocked(scanPackage).mockResolvedValue({ ...scanned, packageName: "my-pkg" });

        await createProgram().parseAsync([
          "node", "test", "check", "my-pkg", "--registry-url", URL_WITH_USERINFO, "--no-contribute",
        ]);

        expect(printed()).toContain(
          `  Registry lookup failed (${quoted}https://[redacted]@registry.example.test${query}); proceeding with local scan.`,
        );
        expect(printed()).not.toContain(PLANTED_NAME);
        expect(printed()).not.toContain(PLANTED_WORD);
      });
    });

    it("is listed in check --help", () => {
      const help = createProgram()
        .commands.find((c) => c.name() === "check")!
        .helpInformation();
      expect(help).toMatch(/--all\s+print every finding/);
    });
  });

  describe("--scan-path looks up each finding's file in the directory", () => {
    let dir: string;

    // The directory holds src/index.js and no Dockerfile.
    function scanned(): ScanResult {
      return {
        packageName: "fixture",
        scan: {
          score: 88,
          maxScore: 100,
          findings: [
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
            },
            {
              checkId: "SANDBOX-001",
              name: "Container Isolation",
              description: "",
              category: "sandboxing",
              severity: "medium",
              passed: false,
              message: "Consider running in Docker containers for isolation",
              file: "Dockerfile",
            },
          ],
          projectType: "api",
          timestamp: "2026-10-18T00:00:00Z",
        },
        trustScore: 0.88,
        trustLevel: 2,
        verdict: "safe",
      };
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ai-trust-finding-files-"));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.js"), "placeholder\n");
      vi.mocked(isHmaAvailable).mockResolvedValue(true);
      vi.mocked(scanLocalPath).mockResolvedValue(scanned());
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("passes the directory and the files it does not have to the text output", async () => {
      await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", dir, "--no-deep"]);

      expect(formatScanResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ remote: false, scanPath: dir, absentFiles: new Set(["Dockerfile"]) }),
      );
    });

    it("gives --json the Verify command of a finding whose file is there, and none for one whose file is not", async () => {
      await createProgram().parseAsync([
        "node", "test", "check", "fixture", "--scan-path", dir, "--no-deep", "--json",
      ]);

      const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(out.findings[0].verify).toBe(`sed -n '12p' ${join(dir, "src", "index.js")}`);
      expect(out.findings[1].file).toBe("Dockerfile");
      expect(out.findings[1]).not.toHaveProperty("verify");
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

      expect(sentSummaryPackages()).toEqual([{ name: "scan-me", ecosystem: "npm" }]);
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
      expect(sentSummaryPackages()).toEqual([
        { name: "scan-me", version: "1.2.3", ecosystem: "npm" },
      ]);
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
      expect(sentSummaryPackages()).toEqual([{ name: "scan-me", ecosystem: "npm" }]);
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
      // AI-TRUST-1: libraries get out-of-scope only — no
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
      // Tier 3 libraries are out of ai-trust's scope and
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

    describe("the --no-scan library branch prints what the comment above it says (#267)", () => {
      // A registry answer for a library that carries a trust score, a trust
      // level and a verdict.
      const answer = {
        name: "chalk",
        found: true,
        verdict: "passed",
        trustLevel: 3,
        trustScore: 0.82,
        packageType: "library",
      };

      function stdoutLines(): string[] {
        return consoleSpy.mock.calls
          .map((args) => args.join(" "))
          .join("\n")
          .replace(/\x1b\[[0-9;]*m/g, "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
      }

      beforeEach(() => {
        vi.mocked(RegistryClient).mockImplementation(
          function () {
            return {
              checkTrust: vi.fn().mockResolvedValue(answer),
              batchQuery: vi.fn(),
              publishScan: vi.fn(),
            } as any;
          }
        );
      });

      it("prints the package name, the out-of-scope notice and the hackmyagent check step, and no trust score, trust level or verdict", async () => {
        await createProgram().parseAsync(["node", "test", "check", "chalk", "--no-scan"]);

        expect(stdoutLines()).toEqual([
          "chalk  library (registry-classified)",
          "Out of scope for ai-trust — the registry classifies this as a general-purpose library.",
          "For a thorough security audit:",
          "npx hackmyagent check chalk",
        ]);
        expect(formatCheckResult).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });

      it("--json nests the registry's answer under registryData beside scored: false", async () => {
        await createProgram().parseAsync(["node", "test", "--json", "check", "chalk", "--no-scan"]);

        expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({
          name: "chalk",
          ecosystem: "npm",
          packageType: "library",
          found: true,
          outOfScope: true,
          scored: false,
          outOfScopeReason: "registry-classified as general-purpose library",
          nextSteps: ["npx hackmyagent check chalk"],
          registryData: answer,
        });
      });

      it("the comment above the call names that output and does not say trust data is shown", () => {
        const lines = readFileSync(
          resolve(dirname(fileURLToPath(import.meta.url)), "check.ts"),
          "utf8",
        ).split("\n");
        const call = lines.findIndex(
          (line) => line.trim() === "printLibraryWithTrust(result, globalOpts.json, ecosystem);",
        );
        expect(call).toBeGreaterThan(0);
        let start = call;
        while (lines[start - 1].trim().startsWith("//")) start -= 1;
        const comment = lines
          .slice(start, call)
          .map((line) => line.trim().replace(/^\/\/ ?/, ""))
          .join(" ");

        expect(comment).toContain(
          "the package name, the out-of-scope notice and the `hackmyagent check` step",
        );
        expect(comment).toContain("no trust score, trust level or verdict");
        expect(comment).toContain("`registryData` beside `scored: false`");
        expect(comment).not.toMatch(/trust data/i);
      });
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

    // A package the registry classifies as a library gets the out-of-scope
    // notice and no scan, so the help does not say every package is scanned.
    it("says every in-scope package is scanned by default (#123)", () => {
      const help = checkHelp().replace(/\s+/g, " ");
      expect(help).toContain("--scan-if-missing deprecated (every in-scope package is scanned by default)");
      expect(help).not.toContain("every package is scanned");
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

  // An unknown --type was sent to the registry, which has no package of that
  // type, and check said a registered MCP server was not found (#177).
  describe("--type is one of the registry's package types (#177)", () => {
    const TYPE_ERROR =
      '--type must be one of mcp_server, a2a_agent, skill, ai_tool, llm, library; got "banana"';
    const FILESYSTEM = "@modelcontextprotocol/server-filesystem";

    // The --scan-path flow ends in process.exit when the scanner cannot run.
    async function runCheck(args: string[]): Promise<void> {
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      try {
        await createProgram().parseAsync(["node", "test", "check", ...args]);
      } finally {
        exit.mockRestore();
      }
    }

    for (const flags of [[], ["--no-scan"], ["--scan-path", "/tmp/project"]]) {
      it(`--type banana ${flags.join(" ") || "with no flag"}: a usage error before any lookup or scan`, async () => {
        await runCheck(["server-filesystem", "--type", "banana", ...flags]);

        expect(consoleErrSpy.mock.calls.map((c) => c.join(" "))).toEqual([`Error: ${TYPE_ERROR}`]);
        expect(consoleSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(RegistryClient).not.toHaveBeenCalled();
        expect(isHmaAvailable).not.toHaveBeenCalled();
        expect(scanPackage).not.toHaveBeenCalled();
        expect(scanLocalPath).not.toHaveBeenCalled();
      });

      it(`-t banana ${flags.join(" ") || "with no flag"} --json: {"error"} on stdout, exit 1`, async () => {
        await runCheck(["server-filesystem", "-t", "banana", ...flags, "--json"]);

        expect(consoleSpy.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({ error: TYPE_ERROR });
        expect(consoleErrSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(RegistryClient).not.toHaveBeenCalled();
        expect(isHmaAvailable).not.toHaveBeenCalled();
      });
    }

    function mockTypedMiss(): ReturnType<typeof vi.fn> {
      const checkTrust = vi.fn().mockRejectedValue(new PackageNotFoundError(FILESYSTEM));
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust, batchQuery: vi.fn(), publishScan: vi.fn() } as any;
      });
      return checkTrust;
    }

    it("--no-scan names the type in the not-found block, as the registry's miss is for that type", async () => {
      const checkTrust = mockTypedMiss();
      const real = await vi.importActual<typeof import("../output/formatter.js")>(
        "../output/formatter.js"
      );
      vi.mocked(formatNotFound).mockImplementationOnce(real.formatNotFound);

      await createProgram().parseAsync([
        "node", "test", "check", "server-filesystem", "--no-scan", "--type", "a2a_agent",
      ]);

      expect(checkTrust).toHaveBeenCalledWith(FILESYSTEM, "a2a_agent");
      const out = consoleSpy.mock.calls
        .map((call) => call.join(" "))
        .join("\n")
        .replace(/\u001b\[[0-9;]*m/g, "");
      expect(out).toContain(`Package not found: ${FILESYSTEM} (npm, type a2a_agent)`);
      expect(process.exitCode).toBe(2);
    });

    it("--no-scan --json names the type in the not-found error", async () => {
      mockTypedMiss();

      await createProgram().parseAsync([
        "node", "test", "check", "server-filesystem", "--no-scan", "--type", "a2a_agent", "--json",
      ]);

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(out).toMatchObject({
        name: FILESYSTEM,
        found: false,
        ecosystem: "npm",
        error: `Package "${FILESYSTEM}" not found in the OpenA2A Registry as type a2a_agent.`,
      });
      expect(process.exitCode).toBe(2);
    });

    it("--no-scan without --type keeps the not-found block and error without a type", async () => {
      mockTypedMiss();

      await createProgram().parseAsync([
        "node", "test", "check", "server-filesystem", "--no-scan", "--json",
      ]);

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(out.error).toBe(`Package "${FILESYSTEM}" not found in the OpenA2A Registry.`);
    });

    it("lists the accepted values in its help", () => {
      const check = createProgram().commands.find((c) => c.name() === "check")!;
      const help = check.helpInformation().replace(/\s+/g, " ");

      expect(help).toContain(
        "-t, --type <type> package type filter (one of mcp_server, a2a_agent, skill, ai_tool, llm, library)"
      );
      expect(help).not.toContain("etc.");
    });

    it("docs/commands.md lists the values --type accepts for check and batch", () => {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const doc = readFileSync(resolve(root, "docs/commands.md"), "utf8");
      const typeFlag =
        "`--type` (one of `mcp_server`, `a2a_agent`, `skill`, `ai_tool`, `llm`, `library`)";

      expect(doc).toContain(`Flags: ${typeFlag}, \`--contribute\``);
      expect(doc).toContain(`Flags: ${typeFlag}, \`--min-trust\``);
    });
  });

  // `<name>@` was looked up as a package named with the `@` and reported not
  // found (exit 2); a name with a control character reached the registry
  // client, whose refusal named its class. Both are usage errors now.
  describe("a target with no version after its @, or with a control character (#230)", () => {
    for (const [target, error] of [
      [
        "@modelcontextprotocol/server-filesystem@",
        'No version after "@modelcontextprotocol/server-filesystem@". Usage: ai-trust check @modelcontextprotocol/server-filesystem@<version>, or ai-trust check @modelcontextprotocol/server-filesystem without the "@"',
      ],
      [
        "pip:requests@",
        'No version after "pip:requests@". Usage: ai-trust check pip:requests@<version>, or ai-trust check pip:requests without the "@"',
      ],
      ["evil\u001b[31m", "The package name contains control characters. Usage: ai-trust check <package>"],
    ] as const) {
      for (const flags of [[], ["--no-scan"]]) {
        it(`check ${JSON.stringify(target)} ${flags.join(" ") || "with no flag"}: a usage error before any lookup or scan`, async () => {
          await createProgram().parseAsync(["node", "test", "check", target, ...flags]);

          expect(consoleErrSpy.mock.calls.map((c) => c.join(" "))).toEqual([`Error: ${error}`]);
          expect(consoleSpy).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
          expect(RegistryClient).not.toHaveBeenCalled();
          expect(isHmaAvailable).not.toHaveBeenCalled();
          expect(scanPackage).not.toHaveBeenCalled();
        });
      }
      it(`check ${JSON.stringify(target)} --no-scan --json: {"error"} on stdout, exit 1`, async () => {
        await createProgram().parseAsync(["node", "test", "check", target, "--no-scan", "--json"]);

        expect(consoleSpy.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({ error });
        expect(consoleErrSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(RegistryClient).not.toHaveBeenCalled();
      });
    }
  });

  describe("flags that change nothing say so (#230)", () => {
    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((args) => args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    }

    function scannedDirectory(): void {
      vi.mocked(isHmaAvailable).mockResolvedValueOnce(true);
      vi.mocked(scanLocalPath).mockResolvedValueOnce({
        packageName: "/tmp/dir",
        scan: {
          score: 100,
          maxScore: 100,
          findings: [],
          projectType: "library",
          timestamp: "2026-10-18T00:00:00Z",
          filesExamined: 3,
        },
        trustScore: 1,
        trustLevel: 3,
        verdict: "safe",
      } as ScanResult);
    }

    it("--scan-path with --no-scan scans the directory and notes that --no-scan was ignored", async () => {
      scannedDirectory();
      await createProgram().parseAsync([
        "node", "test", "check", "x", "--scan-path", "/tmp/dir", "--no-scan",
      ]);

      expect(scanLocalPath).toHaveBeenCalled();
      expect(stderrLines()).toContain(
        "  Note: --no-scan is ignored with --scan-path: the directory is scanned, and the registry is not asked.",
      );
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("--scan-path with --contribute notes that a directory scan is not shared", async () => {
      scannedDirectory();
      await createProgram().parseAsync([
        "node", "test", "check", "x", "--scan-path", "/tmp/dir", "--contribute",
      ]);

      expect(stderrLines()).toContain(
        "  Note: --contribute is ignored with --scan-path: a directory scan is not shared with the registry.",
      );
    });

    it("--scan-path alone prints no note", async () => {
      scannedDirectory();
      await createProgram().parseAsync(["node", "test", "check", "x", "--scan-path", "/tmp/dir"]);

      expect(stderrLines().filter((l) => l.includes("Note:"))).toEqual([]);
    });

    it("--scan-if-missing notes that it is deprecated, as --rescan does, on both paths", async () => {
      scannedDirectory();
      await createProgram().parseAsync([
        "node", "test", "check", "x", "--scan-path", "/tmp/dir", "--scan-if-missing", "--rescan",
      ]);

      expect(stderrLines()).toEqual(
        expect.arrayContaining([
          "  Note: --scan-if-missing is deprecated. Every in-scope package is scanned by default.",
          "  Note: --rescan is deprecated. Local scan is now the default.",
        ]),
      );

      consoleErrSpy.mockClear();
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("my-pkg")),
          batchQuery: vi.fn(),
          publishScan: vi.fn(),
        } as any;
      });
      await createProgram().parseAsync(["node", "test", "check", "my-pkg", "--no-scan", "--scan-if-missing"]);

      expect(stderrLines()).toContain(
        "  Note: --scan-if-missing is deprecated. Every in-scope package is scanned by default.",
      );
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

  it('Exit-code table row "Local scan could not run" gives the code check --scan-path sets', async () => {
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanLocalPath).mockRejectedValue(new Error("ENOENT: no such file or directory"));
    // The code is set as process.exitCode, not passed to process.exit(), so
    // the process exits once its output has drained (#234); a call fails
    // the run.
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", "/nonexistent"]);
    } finally {
      exit.mockRestore();
    }

    const documented = documentedExitCodes().get("Local scan could not run");
    expect(documented, 'docs/commands.md exit-code table has no "Local scan could not run" row').toBeDefined();
    expect(process.exitCode).toBe(documented);
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

// #227: with --json, a check --scan-path whose scan failed printed the error
// and the fix as text on stderr, nothing on stdout, and exited 2.
describe("check --scan-path --json prints a failed scan as JSON on stdout", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  const SCANNER_FAILED =
    "HMA scan failed: Command failed: hackmyagent secure --format json --no-contribute --static-only /tmp/fixture\nscanner crashed\n";

  /**
   * Run `check`; returns the exit code it set. The code is set as
   * process.exitCode, not passed to process.exit(), so the process exits
   * once its output has drained (#234); a call to process.exit() fails the
   * run.
   */
  async function runCheck(args: string[]): Promise<number | undefined> {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await createProgram().parseAsync(["node", "test", ...args]);
    } finally {
      exit.mockRestore();
    }
    return process.exitCode;
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

  it.each([
    ["the scanner exits without a report", SCANNER_FAILED],
    ["the directory does not exist", "/tmp/fixture could not be read (ENOENT)."],
    ["the path is not a directory", "/tmp/fixture is not a directory."],
  ])("prints one object with the error on stdout, nothing on stderr, and exits 2 when %s", async (_label, message) => {
    vi.mocked(scanLocalPath).mockRejectedValue(new Error(message));

    const exitCode = await runCheck([
      "--json", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep",
    ]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      name: "fixture",
      found: false,
      error: message,
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(2);
  });

  it("prints the object the default flow prints for the same failed scan, without an ecosystem", async () => {
    vi.mocked(RegistryClient).mockImplementation(function () {
      return {
        checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("fixture")),
        publishScan: vi.fn(),
      } as any;
    });
    vi.mocked(scanPackage).mockRejectedValue(new Error(SCANNER_FAILED));
    vi.mocked(scanLocalPath).mockRejectedValue(new Error(SCANNER_FAILED));

    await createProgram().parseAsync(["node", "test", "--json", "check", "fixture", "--no-deep"]);
    await runCheck(["--json", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep"]);

    expect(consoleSpy).toHaveBeenCalledTimes(2);
    const [defaultFlow, scanPath] = consoleSpy.mock.calls.map((args) => JSON.parse(String(args[0])));
    expect(defaultFlow).toEqual({ name: "fixture", found: false, error: SCANNER_FAILED, ecosystem: "npm" });
    const { ecosystem: _ecosystem, ...withoutEcosystem } = defaultFlow;
    expect(scanPath).toEqual(withoutEcosystem);
  });

  it("without --json prints the error as text on stderr, nothing on stdout, and exits 2", async () => {
    vi.mocked(scanLocalPath).mockRejectedValue(new Error(SCANNER_FAILED));

    const exitCode = await runCheck(["check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep"]);

    expect(consoleSpy).not.toHaveBeenCalled();
    const stderr = consoleErrSpy.mock.calls.map((args) => args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    expect(stderr[0]).toBe(`error: ${SCANNER_FAILED}`);
    expect(exitCode).toBe(2);
  });

  // #234: process.exit(2) right after the print ended the process before an
  // error larger than the pipe buffer was written whole.
  const WITH_AND_WITHOUT_JSON: [string, string[]][] = [
    ["with --json", ["--json"]],
    ["without --json", []],
  ];
  it.each(WITH_AND_WITHOUT_JSON)(
    "sets the exit code without calling process.exit, so the output drains before the process ends, %s",
    async (_label, flags) => {
      vi.mocked(scanLocalPath).mockRejectedValue(new Error(SCANNER_FAILED));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit");
      }) as never);
      try {
        await createProgram().parseAsync([
          "node", "test", ...flags, "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep",
        ]);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }

      expect(process.exitCode).toBe(2);
    },
  );
});

// #235: with --json, a check whose scanner could not be started printed the
// reason as text on stderr and nothing on stdout, and exited 2 with
// --scan-path and 1 in the default flow.
describe("check --json prints a scanner that cannot be started as JSON on stdout", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  const NOT_RUN =
    "ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:";
  // What scannerNodeVersionProblem() returns on Node.js 20.18.3.
  const START_PROBLEM =
    "The hackmyagent version ai-trust pins loads an ES module with require(), which Node.js 20.18.3 does not do (ERR_REQUIRE_ESM). Run ai-trust on Node.js 20.19.0 or a later 20.x release, or on 22.12.0 or later.";

  /**
   * Run `check` with process.exit stubbed; returns the code it exited with,
   * or the exit code it set when it did not call process.exit.
   */
  async function runCheck(args: string[]): Promise<number | undefined> {
    let exitCode: number | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("process.exit");
    }) as never);
    try {
      await createProgram().parseAsync(["node", "test", ...args]).catch(() => {});
    } finally {
      exit.mockRestore();
    }
    return exitCode ?? (process.exitCode as number | undefined);
  }

  /** The lines printed on stderr, without colour codes. */
  function stderrLines(): string[] {
    return consoleErrSpy.mock.calls.map((args) => args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.mocked(isHmaAvailable).mockResolvedValue(false);
    // The registry does not have the package, so the default flow goes on to scan it.
    vi.mocked(RegistryClient).mockImplementation(function () {
      return {
        checkTrust: vi.fn().mockRejectedValue(new PackageNotFoundError("fixture")),
        publishScan: vi.fn(),
      } as any;
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it("--scan-path prints one object with the reinstall command in its error, nothing on stderr, and exits 2", async () => {
    const exitCode = await runCheck([
      "--json", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep",
    ]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      name: "fixture",
      found: false,
      error: `HMA is not available. ${NOT_RUN} cd /work/project && npm install`,
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(2);
    expect(scanLocalPath).not.toHaveBeenCalled();
  });

  it("--scan-path gives why the scanner could not be started as the error", async () => {
    vi.mocked(scannerNodeVersionProblem).mockReturnValueOnce(START_PROBLEM);

    const exitCode = await runCheck([
      "--json", "check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep",
    ]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      name: "fixture",
      found: false,
      error: `HMA could not be started. ${START_PROBLEM}`,
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(2);
  });

  it("the default flow prints one object with the reinstall command in its error, nothing on stderr, and exits 1", async () => {
    const exitCode = await runCheck(["--json", "check", "fixture", "--no-deep"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      name: "fixture",
      found: false,
      error: `HMA (HackMyAgent) is required for scanning. ${NOT_RUN} cd /work/project && npm install`,
      ecosystem: "npm",
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(scanPackage).not.toHaveBeenCalled();
  });

  it("the default flow gives why the scanner could not be started as the error, with the target's ecosystem", async () => {
    vi.mocked(scannerNodeVersionProblem).mockReturnValueOnce(START_PROBLEM);

    const exitCode = await runCheck(["--json", "check", "pip:fixture", "--no-deep"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      name: "fixture",
      found: false,
      error: `HMA (HackMyAgent) is required for scanning, and it could not be started. ${START_PROBLEM}`,
      ecosystem: "pypi",
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it("without --json, --scan-path prints the reason as text on stderr, nothing on stdout, and exits 2", async () => {
    const exitCode = await runCheck(["check", "fixture", "--scan-path", "/tmp/fixture", "--no-deep"]);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([
      `error: HMA is not available. ${NOT_RUN} cd /work/project && npm install`,
    ]);
    expect(exitCode).toBe(2);
  });

  it("without --json, the default flow prints the reason and the reinstall command as text on stderr, nothing on stdout, and exits 1", async () => {
    const exitCode = await runCheck(["check", "fixture", "--no-deep"]);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual([
      `HMA (HackMyAgent) is required for scanning. ${NOT_RUN}`,
      "  cd /work/project && npm install",
    ]);
    expect(exitCode).toBe(1);
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
  let savedExitCode: number | undefined;

  const DIRECTORY_FIX = "Fix: pass --scan-path to a directory that exists and is readable.";

  function stderrLines(): string[] {
    return consoleErrSpy.mock.calls.map((args) =>
      args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""),
    );
  }

  /**
   * Run `check fixture --scan-path <dir> --no-deep`; returns the exit code
   * it set. The code is set as process.exitCode, not passed to
   * process.exit(), so the process exits once its output has drained
   * (#234); a call to process.exit() fails the run.
   */
  async function checkScanPath(dir: string): Promise<number | undefined> {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await createProgram().parseAsync(["node", "test", "check", "fixture", "--scan-path", dir, "--no-deep"]);
    } finally {
      exit.mockRestore();
    }
    return process.exitCode;
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
    ["does not exist", "/nonexistent", "/nonexistent could not be read (ENOENT)."],
    ["is a file", "/tmp/fixture.txt", "/tmp/fixture.txt is not a directory."],
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
