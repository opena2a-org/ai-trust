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
vi.mock("@opena2a/contribute", () => ({
  contribute: {
    scanResult: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(false),
  },
  getContributorToken: vi.fn().mockReturnValue("a".repeat(64)),
}));

import { RegistryClient } from "@opena2a/registry-client";
import { parseDependencyFile, detectEcosystem } from "../utils/parser.js";
import { formatBatchResults } from "../output/formatter.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";
import { sendScanPing } from "../telemetry/contribute.js";
import { readContributeChoice, saveContributeChoice } from "../telemetry/opt-in.js";
import { contribute } from "@opena2a/contribute";
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
  });

  describe("a registry that does not answer: the next step (#177)", () => {
    function registryFails(message: string, code: string): void {
      vi.mocked(parseDependencyFile).mockResolvedValue([{ name: "some-mcp" }]);
      const err = Object.assign(new Error(message), { code });
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery: vi.fn().mockRejectedValue(err) } as any;
      });
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

      expect(stderrLines()[1]).toBe(
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

    it("adds no next step when the registry answered with an error", async () => {
      registryFails("Registry server error (500)", "server_error");
      await createProgram().parseAsync(["node", "test", "audit", "package.json"]);

      expect(stderrLines()).toEqual(["Error: Registry server error (500)"]);
      expect(process.exitCode).toBe(1);
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
    expect(contribute.scanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "leaky-pkg", ecosystem: "npm", packageVersion: "4.5.6" })
      );
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
    expect(contribute.scanResult).toHaveBeenCalledWith(
        expect.objectContaining({ packageName: "py-pkg", ecosystem: "pypi", packageVersion: "0.9.1" })
      );
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
    expect(printed).not.toMatch(/Scan data shared/i);
    expect(printed).not.toMatch(/Thank you for building trust/i);
    expect(printed).not.toMatch(/Published to registry/i);
  });
});
