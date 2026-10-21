/**
 * Tests for the audit command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerAuditCommand } from "./audit.js";
import { shellArg } from "../utils/shell-arg.js";

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
  reinstallCommand: vi.fn().mockReturnValue("npm install -g ai-trust"),
  scanPackage: vi.fn(),
  scannerNodeVersionProblem: vi.fn().mockReturnValue(null),
  scannerTempDirProblem: vi.fn().mockReturnValue(null),
}));

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

import { RegistryClient } from "@opena2a/registry-client";
import { parseDependencyFile, detectEcosystem } from "../utils/parser.js";
import { formatBatchResults } from "../output/formatter.js";
import { isHmaAvailable, scanPackage, scannerNodeVersionProblem } from "../scanner/index.js";
import { sendScanPing } from "../telemetry/contribute.js";
import { readContributeChoice, saveContributeChoice } from "../telemetry/opt-in.js";
import { contribute, submitBatch } from "@opena2a/contribute";

/** The package of each scan summary sent at once, in the order sent. */
function sentSummaryPackages(): unknown[] {
  return vi
    .mocked(submitBatch)
    .mock.calls.flatMap(([batch]) => batch.events.map((event) => event.package));
}
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

  // parseInt read 2.5 as level 2 and the audit passed at that level.
  it("rejects a --min-trust that is not a whole number before reading the file", async () => {
    await createProgram().parseAsync([
      "node", "test", "audit", "package.json", "--min-trust", "2.5",
    ]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: --min-trust must be a whole number between 0 and 4, not 2.5"
    );
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(parseDependencyFile).not.toHaveBeenCalled();
    expect(RegistryClient).not.toHaveBeenCalled();
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

  // With --json a usage error is one JSON object on stdout and nothing on
  // stderr, as for a --registry-url usage error.
  describe("usage errors with --json (#191)", () => {
    for (const value of ["9", "-1", "abc"]) {
      it(`--min-trust ${value} --json: {"error"} on stdout, exit 1`, async () => {
        await createProgram().parseAsync([
          "node", "test", "--json", "audit", "package.json", "--min-trust", value,
        ]);

        expect(consoleSpy.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
          error: "--min-trust must be a number between 0 and 4",
        });
        expect(consoleErrSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(parseDependencyFile).not.toHaveBeenCalled();
        expect(RegistryClient).not.toHaveBeenCalled();
      });
    }

    it('more than 100 dependencies with --json: {"file", "error"} on stdout, exit 1', async () => {
      vi.mocked(parseDependencyFile).mockResolvedValue(
        Array.from({ length: 101 }, (_, i) => ({ name: `pkg-${i}` }))
      );

      await createProgram().parseAsync(["node", "test", "--json", "audit", "package.json"]);

      expect(consoleSpy.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        file: "package.json",
        error:
          "Too many dependencies (101). The batch API supports a maximum of 100 packages per request.",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });
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

  // The text comes from the real formatter here, so the exit code and the
  // line that gives its reason are read from the same run.
  describe("the Summary line that says why audit exits 2", () => {
    async function auditLines(
      results: Array<{ name: string; found: boolean } & Record<string, unknown>>,
      args: string[]
    ): Promise<string[]> {
      const actualFormatter = await vi.importActual<
        typeof import("../output/formatter.js")
      >("../output/formatter.js");
      vi.mocked(formatBatchResults).mockImplementationOnce(actualFormatter.formatBatchResults);
      vi.mocked(parseDependencyFile).mockResolvedValue(results.map((r) => ({ name: r.name })));
      const found = results.filter((r) => r.found).length;
      const mockBatchQuery = vi.fn().mockResolvedValue({
        results,
        meta: { total: results.length, found, notFound: results.length - found },
      });
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      });

      await createProgram().parseAsync(["node", "test", "audit", ...args]);

      return consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n");
    }

    const aiPackage = {
      name: "my-mcp",
      found: true,
      packageType: "mcp_server",
      trustLevel: 3,
      trustScore: 0.85,
      verdict: "safe",
      scanStatus: "complete",
    };

    it("exits 2 and names an unclassified name the registry does not have, with --scan-missing for the file", async () => {
      const lines = await auditLines(
        [aiPackage, { name: "novel-random-pkg", found: false, trustLevel: 0, verdict: "unknown" }],
        ["package.json"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain(
        "  Audit failed: 1 dependency is not in the registry and was not scanned: novel-random-pkg"
      );
      expect(lines).toContain("  Next: ai-trust audit package.json --scan-missing");
      expect(lines.join("\n")).not.toContain("meets minimum trust level");
    });

    it("exits 2 for a library the registry blocks, and names it", async () => {
      const lines = await auditLines(
        [
          aiPackage,
          { name: "bad-lib", found: true, packageType: "library", trustLevel: 0, verdict: "blocked" },
        ],
        ["package.json"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain("  Audit failed: 1 dependency is below minimum trust level 2: bad-lib");
      expect(lines).toContain("  Next: ai-trust check bad-lib");
      expect(lines.join("\n")).not.toContain("meets minimum trust level");
    });

    it("checks a requirements.txt dependency below the level as pip:<name>", async () => {
      vi.mocked(detectEcosystem).mockReturnValueOnce("pypi");
      const lines = await auditLines(
        [{ name: "risky-pkg", found: true, packageType: "mcp_server", trustLevel: 1, verdict: "warning" }],
        ["requirements.txt"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain("  Next: ai-trust check pip:risky-pkg");
    });

    it("after --scan-missing could not scan a package, gives the check command for it, not the same scan", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValueOnce(true);
      vi.mocked(scanPackage).mockRejectedValueOnce(new Error("not found on npm"));
      const lines = await auditLines(
        [aiPackage, { name: "novel-random-pkg", found: false, trustLevel: 0, verdict: "unknown" }],
        ["package.json", "--scan-missing", "--no-contribute"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain(
        "  Audit failed: 1 dependency is not in the registry and was not scanned: novel-random-pkg"
      );
      expect(lines).toContain("  Next: ai-trust check novel-random-pkg");
      expect(lines.join("\n")).not.toContain("Next: ai-trust audit");
    });

    it("after --scan-missing could not scan an AI package, the Next Steps check it and offer no scan again", async () => {
      vi.mocked(isHmaAvailable).mockResolvedValueOnce(true);
      vi.mocked(scanPackage).mockRejectedValueOnce(new Error("not found on npm"));
      const lines = await auditLines(
        [
          aiPackage,
          { name: "missing-mcp", found: false, packageType: "mcp_server", trustLevel: 0, verdict: "unknown" },
        ],
        ["package.json", "--scan-missing", "--no-contribute"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain("  Next: ai-trust check missing-mcp");
      expect(lines).toContain("  Check individual:  ai-trust check missing-mcp");
      expect(lines.join("\n")).not.toContain("Scan missing:");
      expect(lines.join("\n")).not.toContain("<file>");
    });

    it("names the file it read in the Next Steps scan of a missing AI package", async () => {
      const lines = await auditLines(
        [
          aiPackage,
          { name: "missing-mcp", found: false, packageType: "mcp_server", trustLevel: 0, verdict: "unknown" },
        ],
        ["package.json"]
      );

      expect(process.exitCode).toBe(2);
      expect(lines).toContain("  Scan missing:      ai-trust audit package.json --scan-missing");
      expect(lines).toContain("  Check individual:  ai-trust check missing-mcp");
    });

    it("after yes at the scan prompt on a terminal could not scan a package, gives the check command for it", async () => {
      const savedIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      try {
        vi.mocked(confirm).mockResolvedValueOnce(true);
        vi.mocked(isHmaAvailable).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        vi.mocked(scanPackage).mockRejectedValueOnce(new Error("not found on npm"));
        const lines = await auditLines(
          [aiPackage, { name: "novel-random-pkg", found: false, trustLevel: 0, verdict: "unknown" }],
          ["package.json", "--no-contribute"]
        );

        expect(confirm).toHaveBeenCalled();
        expect(process.exitCode).toBe(2);
        expect(lines).toContain("  Next: ai-trust check novel-random-pkg");
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: savedIsTTY, configurable: true });
      }
    });

    it("exits 0 and prints the meets line when every dependency passes", async () => {
      const lines = await auditLines(
        [
          aiPackage,
          { name: "left-pad", found: true, packageType: "library", trustLevel: 2, verdict: "listed" },
        ],
        ["package.json"]
      );

      expect(process.exitCode).toBeUndefined();
      expect(lines).toContain("  The AI package meets minimum trust level 2.");
      expect(lines.join("\n")).not.toContain("Audit failed");
    });
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
    // Only a missing file gets the accepted-files and next-command lines.
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
  });

  // These use files in a temporary directory, and the real parser (and, for
  // the text output, the real formatter) where a test says so.
  describe("the file audit reads, and what it names", () => {
    let dir: string;
    let fetchSpy: MockInstance<typeof fetch>;

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    async function useRealParser(): Promise<void> {
      const actual = await vi.importActual<typeof import("../utils/parser.js")>(
        "../utils/parser.js"
      );
      vi.mocked(parseDependencyFile).mockImplementationOnce(actual.parseDependencyFile);
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-file-"));
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("no network in tests"));
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses README.md with exit 1 before reading it, and asks the registry nothing", async () => {
      const readme = join(dir, "README.md");
      writeFileSync(readme, "# DVAA\n\ndocker compose up\nhackmyagent secure .\n2 services\n");

      await createProgram().parseAsync(["node", "test", "audit", readme]);

      expect(stderrLines()).toEqual([
        "Error: audit reads package.json or requirements.txt; README.md is neither.",
        "  Next: ai-trust audit --help",
      ]);
      expect(process.exitCode).toBe(1);
      expect(parseDependencyFile).not.toHaveBeenCalled();
      expect(RegistryClient).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("prints the refusal as the --json error object", async () => {
      const readme = join(dir, "README.md");
      writeFileSync(readme, "# DVAA\n");

      await createProgram().parseAsync(["node", "test", "--json", "audit", readme]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        file: readme,
        error: "audit reads package.json or requirements.txt; README.md is neither.",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(parseDependencyFile).not.toHaveBeenCalled();
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("reports a missing README.md as not found, as for any missing file", async () => {
      const missing = join(dir, "README.md");
      await useRealParser();

      await createProgram().parseAsync(["node", "test", "audit", missing]);

      expect(stderrLines()[0]).toBe(`Error: File not found: ${missing}`);
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("leaves a directory to the directory error instead of refusing it by name", async () => {
      const sub = join(dir, "dvaa");
      mkdirSync(sub);
      await useRealParser();

      await createProgram().parseAsync(["node", "test", "audit", sub]);

      expect(parseDependencyFile).toHaveBeenCalledWith(sub);
      expect(stderrLines()[0]).toMatch(/^Error: .*directory/);
      expect(stderrLines().join("\n")).not.toContain("is neither");
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("names a dependency the registry does not have, which is why it exits 2", async () => {
      const manifest = join(dir, "package.json");
      writeFileSync(
        manifest,
        JSON.stringify({ dependencies: { express: "^4.18.2", child_process: "^1.0.2" } })
      );
      await useRealParser();
      const actualFormatter = await vi.importActual<
        typeof import("../output/formatter.js")
      >("../output/formatter.js");
      vi.mocked(formatBatchResults).mockImplementationOnce(actualFormatter.formatBatchResults);
      const mockBatchQuery = vi.fn().mockResolvedValue({
        results: [
          { name: "express", found: true, packageType: "library", trustLevel: 2, verdict: "listed" },
          { name: "child_process", found: false, trustLevel: 0, verdict: "unknown" },
        ],
        meta: { total: 2, found: 1, notFound: 1 },
      });
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      });

      await createProgram().parseAsync(["node", "test", "audit", manifest]);

      expect(mockBatchQuery).toHaveBeenCalledWith([{ name: "express" }, { name: "child_process" }]);
      const text = String(consoleSpy.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
      expect(text.split("\n")).toContain("  │ child_process");
      expect(process.exitCode).toBe(2);
    });
  });

  describe("file not found: what audit reads and the next command", () => {
    let dir: string;
    let cwdSpy: MockInstance<() => string>;

    function missing(file: string): void {
      const err = new Error(
        `ENOENT: no such file or directory, open '${file}'`
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      vi.mocked(parseDependencyFile).mockRejectedValue(err);
    }

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-"));
      cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("points to the help when the directory holds no file audit reads", async () => {
      missing("package.json");
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      expect(stderrLines()).toEqual([
        "Error: File not found: package.json",
        "  No dependencies were checked. The audit command reads package.json or requirements.txt.",
        "  Next: ai-trust audit --help",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("names requirements.txt when it sits beside a missing package.json", async () => {
      writeFileSync(join(dir, "requirements.txt"), "");
      missing("package.json");
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      expect(stderrLines()).toEqual([
        "Error: File not found: package.json",
        "  No dependencies were checked. The audit command reads package.json or requirements.txt.",
        "  Next: ai-trust audit requirements.txt",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("points to the help when the argument has a directory part", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      missing("sub/package.json");
      await createProgram().parseAsync(["node", "test", "audit", "sub/package.json"]);

      expect(stderrLines()).toEqual([
        "Error: File not found: sub/package.json",
        "  No dependencies were checked. The audit command reads package.json or requirements.txt.",
        "  Next: ai-trust audit --help",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("keeps the --json error object unchanged", async () => {
      missing("package.json");
      await createProgram().parseAsync(["node", "test", "--json", "audit", "package.json"]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        file: "package.json",
        error: "File not found: package.json",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("a directory given as the file: what audit reads and the next command (#177)", () => {
    let dir: string;

    // What readFile throws for a directory.
    function isDirectory(): void {
      const err = new Error(
        "EISDIR: illegal operation on a directory, read"
      ) as NodeJS.ErrnoException;
      err.code = "EISDIR";
      vi.mocked(parseDependencyFile).mockRejectedValue(err);
    }

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-dir-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("names the package.json in that directory", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "requirements.txt"), "");
      isDirectory();
      await createProgram().parseAsync(["node", "test", "audit", dir]);

      expect(parseDependencyFile).toHaveBeenCalledWith(dir);
      expect(stderrLines()).toEqual([
        `Error: ${dir} is a directory, not a dependency file`,
        "  No dependencies were checked. The audit command reads package.json or requirements.txt.",
        `  Next: ai-trust audit ${shellArg(join(dir, "package.json"))}`,
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("names the requirements.txt in that directory when it holds no package.json", async () => {
      writeFileSync(join(dir, "requirements.txt"), "");
      isDirectory();
      await createProgram().parseAsync(["node", "test", "audit", dir]);

      expect(stderrLines()[2]).toBe(`  Next: ai-trust audit ${shellArg(join(dir, "requirements.txt"))}`);
      expect(process.exitCode).toBe(1);
    });

    it("quotes a directory name the shell would split", async () => {
      const spaced = join(dir, "my project");
      mkdirSync(spaced);
      writeFileSync(join(spaced, "package.json"), "{}");
      isDirectory();
      await createProgram().parseAsync(["node", "test", "audit", spaced]);

      const next = stderrLines()[2];
      expect(next).toBe(`  Next: ai-trust audit ${shellArg(join(spaced, "package.json"))}`);
      expect(next).toMatch(/^ {2}Next: ai-trust audit '.*my project\/package\.json'$/);
    });

    it("points to the help when the directory holds no file audit reads", async () => {
      isDirectory();
      await createProgram().parseAsync(["node", "test", "audit", dir]);

      expect(stderrLines()[2]).toBe("  Next: ai-trust audit --help");
      expect(process.exitCode).toBe(1);
    });

    it("--json reports the directory in the error object", async () => {
      isDirectory();
      await createProgram().parseAsync(["node", "test", "--json", "audit", dir]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        file: dir,
        error: `${dir} is a directory, not a dependency file`,
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("a file name longer than the file system allows (#189)", () => {
    // 300 bytes: opening it fails with ENAMETOOLONG.
    const longName = "requirements".repeat(25);
    let dir: string;
    let cwdSpy: MockInstance<() => string>;

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    // The file system's own ENAMETOOLONG, not a constructed one.
    async function useRealParser(): Promise<void> {
      const actual = await vi.importActual<typeof import("../utils/parser.js")>(
        "../utils/parser.js"
      );
      vi.mocked(parseDependencyFile).mockImplementationOnce(actual.parseDependencyFile);
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-long-"));
      cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("says the name is too long, shows its first 57 characters, and points to the help", async () => {
      await useRealParser();
      await createProgram().parseAsync(["node", "test", "audit", longName]);

      expect(stderrLines()).toEqual([
        `Error: File name is longer than the file system allows (300 bytes): ${longName.slice(0, 57)}...`,
        "  No dependencies were checked. The audit command reads package.json or requirements.txt.",
        "  Next: ai-trust audit --help",
      ]);
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("names the package.json in the current directory as the next step", async () => {
      writeFileSync(join(dir, "package.json"), "{}");
      await useRealParser();
      await createProgram().parseAsync(["node", "test", "audit", longName]);

      expect(stderrLines()[2]).toBe("  Next: ai-trust audit package.json");
      expect(process.exitCode).toBe(1);
    });

    it("keeps a 100,011-character name to one short line", async () => {
      const huge = "a".repeat(100_011);
      await useRealParser();
      await createProgram().parseAsync(["node", "test", "audit", huge]);

      const first = stderrLines()[0];
      expect(first).toBe(
        `Error: File name is longer than the file system allows (100011 bytes): ${"a".repeat(57)}...`
      );
      expect(first.length).toBe(131);
      expect(stderrLines()).toHaveLength(3);
      expect(process.exitCode).toBe(1);
    });

    it("--json gives the shortened name in the error and the argument in file", async () => {
      await useRealParser();
      await createProgram().parseAsync(["node", "test", "--json", "audit", longName]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(out).toEqual({
        file: longName,
        error: `File name is longer than the file system allows (300 bytes): ${longName.slice(0, 57)}...`,
      });
      expect(out.error).not.toContain(longName);
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    describe("an emoji where the name is cut (#195)", () => {
      // 310 bytes. The emoji's two UTF-16 code units sit at indexes 56 and
      // 57, so a cut at 57 characters would keep only its high half.
      const emojiName = `${"a".repeat(56)}\u{1F600}${"b".repeat(250)}`;
      const shown = `${"a".repeat(56)}...`;

      it("ends the shown name before the emoji, not inside it", async () => {
        await useRealParser();
        await createProgram().parseAsync(["node", "test", "audit", emojiName]);

        expect(stderrLines()[0]).toBe(
          `Error: File name is longer than the file system allows (310 bytes): ${shown}`
        );
        expect(stderrLines()[0]).not.toMatch(/\p{Cs}/u);
        expect(process.exitCode).toBe(1);
      });

      it("--json gives an error field with no lone surrogate", async () => {
        await useRealParser();
        await createProgram().parseAsync(["node", "test", "--json", "audit", emojiName]);

        const printed = String(consoleSpy.mock.calls[0][0]);
        expect(printed).not.toContain("\\ud83d");
        expect(JSON.parse(printed).error).toBe(
          `File name is longer than the file system allows (310 bytes): ${shown}`
        );
        expect(process.exitCode).toBe(1);
      });
    });
  });

  describe("a failed registry request: the registry and the next step (#177, #237)", () => {
    function registryFails(message: string, code: string): void {
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "some-mcp" }]);
      const err = Object.assign(new Error(message), { code });
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery: vi.fn().mockRejectedValue(err) } as any;
      });
    }

    type RegistryApiErrorArgs = ConstructorParameters<
      typeof import("@opena2a/registry-client").RegistryApiError
    >;

    /** The client's own error class; the module mock above does not carry it. */
    async function registryApiError(...args: RegistryApiErrorArgs): Promise<Error> {
      const { RegistryApiError } = await vi.importActual<
        typeof import("@opena2a/registry-client")
      >("@opena2a/registry-client");
      return new RegistryApiError(...args);
    }

    function registryFailsWith(err: Error): ReturnType<typeof vi.fn> {
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "some-mcp" }]);
      const batchQuery = vi.fn().mockRejectedValue(err);
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery } as any;
      });
      return batchQuery;
    }

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    it("says nothing was checked and names check, which scans when the registry does not answer", async () => {
      registryFails("Registry network error: fetch failed", "network");
      await createProgram().parseAsync([
        "node", "test", "audit", "package.json", "--registry-url", "http://127.0.0.1:9",
      ]);

      expect(stderrLines()).toEqual([
        "Error: Registry network error: fetch failed",
        "  No dependencies were checked: the registry at http://127.0.0.1:9 did not answer.",
        "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check <package>",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("gives the same next step for a request that timed out", async () => {
      registryFails("Registry request timed out after 15000ms", "timeout");
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      // Both attempts timed out: a line said so before the second one, and
      // the error gives the time both took, not the limit of one (#230).
      const lines = stderrLines();
      expect(lines[0]).toBe(
        "  The registry at https://api.test.com did not answer within 15000 ms; trying once more."
      );
      expect(lines[1]).toMatch(
        /^Error: Registry request timed out: the registry at https:\/\/api\.test\.com did not answer in \d+(\.\d)? s \(2 attempts of up to 15000 ms each\)$/
      );
      expect(lines[2]).toBe(
        "  No dependencies were checked: the registry at https://api.test.com did not answer."
      );
      expect(process.exitCode).toBe(1);
    });

    it("names the pip: form of check for a requirements.txt", async () => {
      vi.mocked(detectEcosystem).mockReturnValue("pypi");
      try {
        registryFails("Registry network error: fetch failed", "network");
        await createProgram().parseAsync(["node", "test", "audit", "requirements.txt"]);

        expect(stderrLines()[2]).toBe(
          "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check pip:<package>"
        );
      } finally {
        vi.mocked(detectEcosystem).mockReturnValue("npm");
      }
    });

    it("names the status a registry that answered with an error gave, and the same next step (#237)", async () => {
      const batchQuery = registryFailsWith(
        await registryApiError("Registry API returned 500", "server_error", 500, "{}")
      );
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      expect(stderrLines()).toEqual([
        "Error: Registry API returned 500",
        "  No dependencies were checked: the registry at https://api.test.com answered 500.",
        "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check <package>",
      ]);
      expect(batchQuery).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    it("says the answer was not JSON when the registry answered with a body that does not parse (#237)", async () => {
      registryFailsWith(
        await registryApiError(
          "Registry returned invalid JSON: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
          "invalid_response",
          200
        )
      );
      await createProgram().parseAsync([
        "node", "test", "audit", "package.json", "--registry-url", "http://127.0.0.1:8080",
      ]);

      expect(stderrLines()).toEqual([
        "Error: Registry returned invalid JSON: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
        "  No dependencies were checked: the registry at http://127.0.0.1:8080 answered 200 with a body that is not JSON.",
        "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check <package>",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("names the pip: form of check after an answered error for a requirements.txt (#237)", async () => {
      vi.mocked(detectEcosystem).mockReturnValue("pypi");
      try {
        registryFailsWith(
          await registryApiError("Registry API returned 503", "server_error", 503, "")
        );
        await createProgram().parseAsync(["node", "test", "audit", "requirements.txt"]);

        expect(stderrLines().slice(1)).toEqual([
          "  No dependencies were checked: the registry at https://api.test.com answered 503.",
          "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check pip:<package>",
        ]);
      } finally {
        vi.mocked(detectEcosystem).mockReturnValue("npm");
      }
    });

    it("adds no registry line for an error the registry client did not raise", async () => {
      registryFailsWith(new Error("unexpected failure"));
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      expect(stderrLines()).toEqual(["Error: unexpected failure"]);
      expect(process.exitCode).toBe(1);
    });

    it("leaves the --json output of an answered error as it was: one object on stdout, nothing on stderr", async () => {
      registryFailsWith(
        await registryApiError("Registry API returned 500", "server_error", 500, "{}")
      );
      await createProgram().parseAsync(["node", "test", "--json", "audit", "package.json"]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
        file: "package.json",
        error: "Registry API returned 500",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("removes control characters from the registry URL it names", async () => {
      registryFails("Registry network error: fetch failed", "network");
      await createProgram().parseAsync([
        "node", "test", "audit", "package.json",
        "--registry-url", "http://127.0.0.1:9/\u001b[2J\u0007api",
      ]);

      expect(stderrLines()[1]).toBe(
        "  No dependencies were checked: the registry at http://127.0.0.1:9/[2Japi did not answer."
      );
    });

    describe("with a user name and password in --registry-url (#232)", () => {
      // Placeholder userinfo: the test needs a URL with user:password@ in it.
      const PLANTED_NAME = "FAKE-USER";
      const PLANTED_WORD = "FAKE-PASSWORD";
      const URL_WITH_USERINFO = "http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:9";
      const QUOTED =
        "Registry network error: Request cannot be constructed from a URL that includes credentials: ";

      function printed(): string {
        return [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]
          .map((c) => String(c[0]))
          .join("\n");
      }

      it("prints the error line with [redacted] in place of them and the registry without them", async () => {
        registryFails(`${QUOTED}${URL_WITH_USERINFO}/api/v1/trust/batch`, "network");
        await createProgram().parseAsync([
          "node", "test", "--registry-url", URL_WITH_USERINFO, "audit", "package.json",
        ]);

        expect(stderrLines()).toEqual([
          `Error: ${QUOTED}http://[redacted]@127.0.0.1:9/api/v1/trust/batch`,
          "  No dependencies were checked: the registry at http://127.0.0.1:9/ did not answer.",
          "  Next: run the audit again when the registry answers, or scan one package locally with ai-trust check <package>",
        ]);
        expect(printed()).not.toContain(PLANTED_NAME);
        expect(printed()).not.toContain(PLANTED_WORD);
        expect(process.exitCode).toBe(1);
      });

      it("--json: the error string has [redacted] in place of them", async () => {
        registryFails(`${QUOTED}${URL_WITH_USERINFO}/api/v1/trust/batch`, "network");
        await createProgram().parseAsync([
          "node", "test", "--json", "--registry-url", URL_WITH_USERINFO, "audit", "package.json",
        ]);

        expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
          file: "package.json",
          error: `${QUOTED}http://[redacted]@127.0.0.1:9/api/v1/trust/batch`,
        });
        expect(printed()).not.toContain(PLANTED_NAME);
        expect(printed()).not.toContain(PLANTED_WORD);
        expect(process.exitCode).toBe(1);
      });
    });
  });

  it("describes --scan-missing without the scanner's abbreviation (#177)", () => {
    const audit = createProgram().commands.find((c) => c.name() === "audit")!;
    const help = audit.helpInformation().replace(/\s+/g, " ");
    expect(help).not.toContain("HMA");
    expect(help).toContain(
      "--scan-missing download and scan the packages the registry has no data for"
    );
  });

  it("--scan-missing names the Node.js version, not a reinstall, when the scanner cannot load on this Node.js", async () => {
    const problem =
      "The hackmyagent version ai-trust pins loads an ES module with require(), which Node.js 20.18.3 does not do (ERR_REQUIRE_ESM). Run ai-trust on Node.js 20.19.0 or a later 20.x release, or on 22.12.0 or later.";
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "esm-pkg" }]);
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          checkTrust: vi.fn(),
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "esm-pkg", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(false);
    vi.mocked(scannerNodeVersionProblem).mockReturnValueOnce(problem);

    await createProgram().parseAsync(["node", "test", "audit", "package.json", "--scan-missing"]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      `HMA (HackMyAgent) is required for scanning, and it could not be started. ${problem}`
    );
    expect(consoleErrSpy).not.toHaveBeenCalledWith(expect.stringContaining("Reinstall"));
    expect(consoleErrSpy).not.toHaveBeenCalledWith("  npm install -g ai-trust");
    expect(scanPackage).not.toHaveBeenCalled();
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
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing",
      ]);

      expect(sendScanPing).not.toHaveBeenCalled();
    });

    it("pings when --contribute is passed", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--contribute",
      ]);

      expect(sendScanPing).toHaveBeenCalled();
    });

    it("--no-contribute is a registered option and does not error", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(undefined);

      const program = createProgram();
      await expect(
        program.parseAsync([
          "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
        ])
      ).resolves.not.toThrow();
    });

    it("--no-contribute overrides a persisted opt-in and suppresses the ping", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(true);

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
    expect(sentSummaryPackages()).toEqual([
      { name: "leaky-pkg", version: "4.5.6", ecosystem: "npm" },
    ]);
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
    expect(sentSummaryPackages()).toEqual([
      { name: "py-pkg", version: "0.9.1", ecosystem: "pypi" },
    ]);
  });

  it("does not download a name the registry answered with when the dependency file does not list it", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "plain-dep" }]);
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "git+file:///tmp/not-a-package", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
          publishScan: vi.fn(),
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(true);

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
    ]);

    expect(scanPackage).not.toHaveBeenCalled();
    const stderr = consoleErrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain(
      "Not scanning git+file:///tmp/not-a-package: the registry answered with a name the dependency file does not list."
    );
  });

  it("downloads the dependency file's spelling of a name the registry answered with in another form", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "Py_Pkg", ecosystem: "pypi" }]);
    vi.mocked(detectEcosystem).mockReturnValueOnce("pypi");
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "py-pkg", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
          publishScan: vi.fn(),
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanPackage).mockResolvedValue({
      packageName: "Py_Pkg",
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
      "node", "test", "audit", "requirements.txt", "--scan-missing", "--no-contribute",
    ]);

    expect(scanPackage).toHaveBeenCalledOnce();
    expect(scanPackage).toHaveBeenCalledWith("Py_Pkg", expect.objectContaining({ ecosystem: "pypi" }));
  });

  describe("share prompt on a terminal", () => {
    let savedIsTTY: boolean | undefined;
    const mockPublishScan = vi.fn();

    beforeEach(() => {
      savedIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      // The user presses Enter, which accepts the prompt's default (yes).
      vi.mocked(confirm).mockResolvedValue(true);
      vi.mocked(readContributeChoice).mockReturnValue(undefined);
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

    it("does not ask again once the user has answered no, and shares nothing (#139)", async () => {
      vi.mocked(readContributeChoice).mockReturnValue(false);

      const program = createProgram();
      await program.parseAsync(["node", "test", "audit", "package.json", "--scan-missing"]);

      expect(confirm).not.toHaveBeenCalled();
      expect(saveContributeChoice).not.toHaveBeenCalled();
      expect(contribute.scanResult).not.toHaveBeenCalled();
      expect(submitBatch).not.toHaveBeenCalled();
      expect(mockPublishScan).not.toHaveBeenCalled();
      expect(sendScanPing).not.toHaveBeenCalled();
    });

    it("calls shared results pseudonymous, not anonymized, because each carries a per-device token (#139)", async () => {
      const program = createProgram();
      await program.parseAsync(["node", "test", "audit", "package.json", "--scan-missing"]);

      const stderr = consoleErrSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(stderr).toContain("pseudonymous");
      expect(stderr).not.toMatch(/anonymi[sz]ed|anonymous/i);
    });

    it("--no-contribute neither asks nor shares, and saves no choice (#96)", async () => {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--no-contribute",
      ]);

      expect(confirm).not.toHaveBeenCalled();
      expect(saveContributeChoice).not.toHaveBeenCalled();
      expect(contribute.scanResult).not.toHaveBeenCalled();
      expect(submitBatch).not.toHaveBeenCalled();
      expect(mockPublishScan).not.toHaveBeenCalled();
      expect(sendScanPing).not.toHaveBeenCalled();
    });
  });

  it("contributes silently once consent is given (no per-scan contribution line)", async () => {
    vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "quiet-pkg" }]);
    vi.mocked(contribute.flush).mockResolvedValue(true);
    const mockPublishScan = vi
      .fn()
      .mockResolvedValue({ publishId: "0123456789abcdef" });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return {
          checkTrust: vi.fn(),
          batchQuery: vi.fn().mockResolvedValue({
            results: [{ name: "quiet-pkg", found: false }],
            meta: { total: 1, found: 0, notFound: 1 },
          }),
          publishScan: mockPublishScan,
        } as any;
      }
    );
    vi.mocked(isHmaAvailable).mockResolvedValue(true);
    vi.mocked(scanPackage).mockResolvedValue({
      packageName: "quiet-pkg",
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
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const program = createProgram();
      await program.parseAsync([
        "node", "test", "audit", "package.json", "--scan-missing", "--contribute",
      ]);
    } finally {
      stderrSpy.mockRestore();
      vi.mocked(contribute.flush).mockResolvedValue(false);
    }

    // The contribution still happens...
    expect(sentSummaryPackages()).toEqual([{ name: "quiet-pkg", ecosystem: "npm" }]);
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
    expect(printed).not.toMatch(/Scan data shared/i);
    expect(printed).not.toMatch(/Thank you for building trust/i);
    expect(printed).not.toMatch(/Published to registry/i);
  });

  // With stdin not a terminal, audit cannot ask whether to share its scans
  // and prints the command that shares them.
  describe("the command that shares the scans when audit cannot ask (#230)", () => {
    let savedIsTTY: boolean | undefined;

    beforeEach(() => {
      savedIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      vi.mocked(readContributeChoice).mockReturnValue(undefined);
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "piped-pkg" }]);
      vi.mocked(RegistryClient).mockImplementation(
        function () {
          return {
            batchQuery: vi.fn().mockResolvedValue({
              results: [{ name: "piped-pkg", found: false }],
              meta: { total: 1, found: 0, notFound: 1 },
            }),
          } as any;
        }
      );
      vi.mocked(isHmaAvailable).mockResolvedValueOnce(true);
      vi.mocked(scanPackage).mockResolvedValueOnce({
        packageName: "piped-pkg",
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
    });

    it.each([
      ["package.json", "package.json"],
      ["docs/demo/requirements.txt", "docs/demo/requirements.txt"],
      ["my deps/package.json", "'my deps/package.json'"],
    ])("names the file it read, %s, as %s", async (file, shown) => {
      await createProgram().parseAsync(["node", "test", "audit", file, "--scan-missing"]);

      const stderr = consoleErrSpy.mock.calls.map((c) =>
        String(c[0]).replace(/\x1b\[[0-9;]*m/g, "")
      );
      expect(stderr).toContain("  1 package(s) scanned for the first time. Share with the community:");
      expect(stderr).toContain(`    ai-trust audit ${shown} --scan-missing --contribute`);
      expect(stderr.join("\n")).not.toContain("<file>");
      expect(sendScanPing).not.toHaveBeenCalled();
    });
  });
});
