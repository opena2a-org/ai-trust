/**
 * Tests for the batch command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerBatchCommand } from "./batch.js";

vi.mock("@opena2a/registry-client", () => ({
  RegistryClient: vi.fn().mockImplementation(function () {
    return {
      batchQuery: vi.fn(),
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

vi.mock("../output/formatter.js", () => ({
  formatBatchResults: vi.fn(() => "formatted-batch"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
}));

import { RegistryClient } from "@opena2a/registry-client";
import { formatBatchResults, formatJson } from "../output/formatter.js";

function createProgram(): Command {
  const program = new Command();
  program
    .option("--registry-url <url>", "registry base URL", "https://api.test.com")
    .option("--json", "output raw JSON", false);
  registerBatchCommand(program);
  return program;
}

describe("batch command", () => {
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

  it("queries multiple packages in a single batch", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "pkg-a", found: true, trustLevel: 4, verdict: "safe" },
        { name: "pkg-b", found: true, trustLevel: 3, verdict: "safe" },
      ],
      meta: { total: 2, found: 2, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "batch", "pkg-a", "pkg-b"]);

    expect(mockBatchQuery).toHaveBeenCalledWith([
      { name: "pkg-a" },
      { name: "pkg-b" },
    ]);
  });

  it("applies type to all packages when -t is provided", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [],
      meta: { total: 0, found: 0, notFound: 0 },
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
      "batch",
      "pkg-a",
      "pkg-b",
      "-t",
      "mcp_server",
    ]);

    expect(mockBatchQuery).toHaveBeenCalledWith([
      { name: "pkg-a", type: "mcp_server" },
      { name: "pkg-b", type: "mcp_server" },
    ]);
  });

  // An unknown --type matched no package, and a registered MCP server was
  // then listed as a package that "aren't registered as AI" (#177).
  describe("--type is one of the registry's package types (#177)", () => {
    const TYPE_ERROR =
      '--type must be one of mcp_server, a2a_agent, skill, ai_tool, llm, library; got "banana"';
    const FILESYSTEM = "@modelcontextprotocol/server-filesystem";
    const FILESYSTEM_MCP = {
      name: FILESYSTEM,
      found: true,
      packageType: "mcp_server",
      trustLevel: 3,
      trustScore: 0.79,
      verdict: "passed",
      scanStatus: "warnings",
    };
    // The registry answers a query with a type for a package of that type
    // only: a package it has under another type comes back as a miss.
    const FILESYSTEM_TYPED_MISS = {
      name: FILESYSTEM,
      found: false,
      packageType: "",
      trustLevel: 0,
      trustScore: 0,
      verdict: "unknown",
    };

    /** Each batchQuery call answers with the next response. */
    function mockBatchAnswers(...responses: unknown[]): ReturnType<typeof vi.fn> {
      const batchQuery = vi.fn();
      for (const response of responses) batchQuery.mockResolvedValueOnce(response);
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery } as any;
      });
      return batchQuery;
    }

    async function useRealFormatter(): Promise<void> {
      const actual = await vi.importActual<typeof import("../output/formatter.js")>(
        "../output/formatter.js"
      );
      vi.mocked(formatBatchResults).mockImplementationOnce(actual.formatBatchResults);
    }

    function stdoutText(): string {
      return consoleSpy.mock.calls
        .map((call) => call.join(" "))
        .join("\n")
        .replace(/\u001b\[[0-9;]*m/g, "");
    }

    it("refuses an unknown --type as a usage error before any lookup", async () => {
      await createProgram().parseAsync([
        "node", "test", "batch", "server-filesystem", "--type", "banana",
      ]);

      expect(consoleErrSpy.mock.calls.map((c) => c.join(" "))).toEqual([`Error: ${TYPE_ERROR}`]);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it('refuses an unknown --type with --json as {"error"} on stdout, exit 1', async () => {
      await createProgram().parseAsync([
        "node", "test", "--json", "batch", "server-filesystem", "-t", "banana",
      ]);

      expect(consoleSpy.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({ error: TYPE_ERROR });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });

    it("lists the accepted values in its help", () => {
      const batch = createProgram().commands.find((c) => c.name() === "batch")!;
      const help = batch.helpInformation().replace(/\s+/g, " ");

      expect(help).toContain(
        "-t, --type <type> package type to apply to all packages (one of mcp_server, a2a_agent, skill, ai_tool, llm, library)"
      );
    });

    it("reports a package found under another type as a type mismatch, not as unregistered", async () => {
      mockBatchAnswers({ results: [FILESYSTEM_MCP], meta: { total: 1, found: 1, notFound: 0 } });
      await useRealFormatter();

      await createProgram().parseAsync([
        "node", "test", "batch", FILESYSTEM, "--type", "a2a_agent",
      ]);

      const out = stdoutText();
      expect(out).toContain("excluded by --type a2a_agent");
      expect(out).toContain("Type mismatch");
      expect(out).toContain(`This package is registered as mcp_server, not a2a_agent:\n  │ ${FILESYSTEM}`);
      expect(out).toContain(`ai-trust batch ${FILESYSTEM} --type mcp_server`);
      expect(out).toContain(`Audit failed: 1 dependency is excluded by --type a2a_agent: ${FILESYSTEM}`);
      expect(out).toContain(`Next: ai-trust batch ${FILESYSTEM} --type mcp_server`);
      expect(out).not.toContain("aren't registered as AI");
      expect(out).not.toContain("Unclassified");
      expect(process.exitCode).toBe(2);
    });

    it("keeps the registry's answer, found: true, in --json and marks it excludedByType", async () => {
      mockBatchAnswers({ results: [FILESYSTEM_MCP], meta: { total: 1, found: 1, notFound: 0 } });

      await createProgram().parseAsync([
        "node", "test", "--json", "batch", FILESYSTEM, "--type", "a2a_agent",
      ]);

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(out.results).toEqual([{ ...FILESYSTEM_MCP, excludedByType: true }]);
      expect(out.meta).toEqual({ total: 1, found: 1, notFound: 0 });
      expect(process.exitCode).toBe(2);
    });

    it("asks the registry again by name for a package it does not have under the type", async () => {
      const batchQuery = mockBatchAnswers(
        { results: [FILESYSTEM_TYPED_MISS], meta: { total: 1, found: 0, notFound: 1 } },
        { results: [FILESYSTEM_MCP], meta: { total: 1, found: 1, notFound: 0 } },
      );
      await useRealFormatter();

      await createProgram().parseAsync([
        "node", "test", "batch", "server-filesystem", "--type", "a2a_agent",
      ]);

      expect(batchQuery.mock.calls).toEqual([
        [[{ name: FILESYSTEM, type: "a2a_agent" }]],
        [[{ name: FILESYSTEM }]],
      ]);
      const out = stdoutText();
      expect(out).toContain(`This package is registered as mcp_server, not a2a_agent:\n  │ ${FILESYSTEM}`);
      expect(out).not.toContain("aren't registered as AI");
      expect(process.exitCode).toBe(2);
    });

    it("gives --json the registry's answer by name for a package it does not have under the type", async () => {
      mockBatchAnswers(
        { results: [FILESYSTEM_TYPED_MISS], meta: { total: 1, found: 0, notFound: 1 } },
        { results: [FILESYSTEM_MCP], meta: { total: 1, found: 1, notFound: 0 } },
      );

      await createProgram().parseAsync([
        "node", "test", "--json", "batch", FILESYSTEM, "--type", "a2a_agent",
      ]);

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(out.results).toEqual([{ ...FILESYSTEM_MCP, excludedByType: true }]);
      expect(out.meta).toEqual({ total: 1, found: 1, notFound: 0 });
      expect(process.exitCode).toBe(2);
    });

    it("leaves a package the registry has under no name and type not found", async () => {
      const miss = { name: "unknown-agent", found: false, trustLevel: 0, trustScore: 0, verdict: "unknown" };
      mockBatchAnswers(
        { results: [miss], meta: { total: 1, found: 0, notFound: 1 } },
        { results: [miss], meta: { total: 1, found: 0, notFound: 1 } },
      );

      await createProgram().parseAsync([
        "node", "test", "--json", "batch", "unknown-agent", "--type", "a2a_agent",
      ]);

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      // The registry's level, score and verdict for a miss are left out (#276).
      expect(out.results).toEqual([{ name: "unknown-agent", found: false }]);
      expect(out.meta).toEqual({ total: 1, found: 0, notFound: 1 });
      expect(process.exitCode).toBe(2);
    });

    it("asks once when the registry has every package under the type", async () => {
      const batchQuery = mockBatchAnswers({
        results: [FILESYSTEM_MCP],
        meta: { total: 1, found: 1, notFound: 0 },
      });

      await createProgram().parseAsync([
        "node", "test", "batch", FILESYSTEM, "--type", "mcp_server",
      ]);

      expect(batchQuery).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("lists a type mismatch beside the trust table of the packages of that type", async () => {
      const agent = { name: "some-agent", found: true, packageType: "a2a_agent", trustLevel: 3, trustScore: 0.8, verdict: "passed", scanStatus: "passed" };
      mockBatchAnswers(
        {
          results: [FILESYSTEM_MCP, { ...FILESYSTEM_TYPED_MISS, name: "some-agent" }],
          meta: { total: 2, found: 1, notFound: 1 },
        },
        { results: [agent], meta: { total: 1, found: 1, notFound: 0 } },
      );
      await useRealFormatter();

      await createProgram().parseAsync([
        "node", "test", "batch", FILESYSTEM, "some-agent", "--type", "mcp_server",
      ]);

      const out = stdoutText();
      expect(out).toContain("1 AI package audited · 1 excluded by --type mcp_server");
      expect(out).toMatch(/@modelcontextprotocol\/server-fi\S*\s+MCP server\s+\S/);
      expect(out).toContain("This package is registered as a2a_agent, not mcp_server:\n  │ some-agent");
      expect(out).not.toMatch(/some-agent\s+a2a_agent/);
      expect(out).not.toContain("not found in registry");
      // The exit code and the Summary read one gate: the type mismatch fails
      // it, so the Summary says why and does not say the table meets the level.
      expect(out).toContain("Audit failed: 1 dependency is excluded by --type mcp_server: some-agent");
      expect(out).toContain("Next: ai-trust batch some-agent --type a2a_agent");
      expect(out).not.toContain("meets minimum trust level");
      expect(process.exitCode).toBe(2);
    });

    it("does not say no AI package was found when the type excluded one", async () => {
      const chalkLibrary = { name: "chalk", found: true, packageType: "library", trustLevel: 3, trustScore: 0.9, verdict: "passed", scanStatus: "passed" };
      mockBatchAnswers(
        {
          results: [chalkLibrary, FILESYSTEM_TYPED_MISS],
          meta: { total: 2, found: 1, notFound: 1 },
        },
        { results: [FILESYSTEM_MCP], meta: { total: 1, found: 1, notFound: 0 } },
      );
      await useRealFormatter();

      await createProgram().parseAsync([
        "node", "test", "batch", "chalk", FILESYSTEM, "--type", "library",
      ]);

      const out = stdoutText();
      expect(out).toContain("No AI packages found in 1 dependency · 1 excluded by --type library");
      expect(out).toContain(`This package is registered as mcp_server, not library:\n  │ ${FILESYSTEM}`);
      expect(out).toContain(`ai-trust batch ${FILESYSTEM} --type mcp_server`);
      expect(out).toContain(`Audit failed: 1 dependency is excluded by --type library: ${FILESYSTEM}`);
      expect(process.exitCode).toBe(2);
    });

    it("documents a type mismatch as exit 2 in the exit-code table", () => {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const section =
        readFileSync(resolve(root, "docs/commands.md"), "utf8")
          .split(/^## Exit codes$/m)[1]
          ?.split(/^## /m)[0] ?? "";

      expect(section).toMatch(/^\| 2 \| Type mismatch: /m);
    });
  });

  it("rejects invalid min-trust values", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "batch",
      "pkg-a",
      "--min-trust",
      "-1",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("rejects more than 100 packages", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `pkg-${i}`);
    const program = createProgram();
    await program.parseAsync(["node", "test", "batch", ...names]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Too many packages (101)")
    );
    expect(process.exitCode).toBe(1);
  });

  // parseInt read 2.5 as level 2.
  it("rejects a --min-trust that is not a whole number", async () => {
    await createProgram().parseAsync(["node", "test", "batch", "pkg-a", "--min-trust", "2.5"]);

    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: --min-trust must be a whole number between 0 and 4, not 2.5"
    );
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(RegistryClient).not.toHaveBeenCalled();
  });

  it("looks up a name given twice, or as a shorthand and in full, once", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [],
      meta: { total: 0, found: 0, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(function () {
      return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
    });

    await createProgram().parseAsync([
      "node", "test", "batch",
      "server-filesystem", "nonexistent-xyz-999", "express", "server-filesystem",
      "@modelcontextprotocol/server-filesystem", "express",
    ]);

    expect(mockBatchQuery).toHaveBeenCalledWith([
      { name: "@modelcontextprotocol/server-filesystem" },
      { name: "nonexistent-xyz-999" },
      { name: "express" },
    ]);
    // The shorthand is noted once, not once for each time it was given.
    const resolved = consoleErrSpy.mock.calls.filter((c) => String(c[0]).startsWith("Resolved:"));
    expect(resolved).toEqual([
      ["Resolved: server-filesystem -> @modelcontextprotocol/server-filesystem"],
    ]);
  });

  it("prints a --min-trust usage error as text on stderr without --json", async () => {
    await createProgram().parseAsync(["node", "test", "batch", "pkg-a", "--min-trust", "9"]);

    // The same words as for 2.5, naming the value (#276).
    expect(consoleErrSpy).toHaveBeenCalledWith(
      "Error: --min-trust must be a whole number between 0 and 4, not 9"
    );
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A tab before 5 was refused as "not 5", with the tab dropped (#282).
  it("names a --min-trust value with whitespace before it as given, with --json", async () => {
    await createProgram().parseAsync([
      "node", "test", "--json", "batch", "pkg-a", "--min-trust", "\t5",
    ]);

    expect(consoleSpy.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      error: '--min-trust must be a whole number between 0 and 4, not "\\t5"',
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(RegistryClient).not.toHaveBeenCalled();
  });

  // With --json a usage error is one JSON object on stdout and nothing on
  // stderr, as for a --registry-url usage error.
  describe("usage errors with --json (#191)", () => {
    for (const value of ["9", "-1", "abc"]) {
      it(`--min-trust ${value} --json: {"error"} on stdout, exit 1`, async () => {
        await createProgram().parseAsync([
          "node", "test", "--json", "batch", "pkg-a", "--min-trust", value,
        ]);

        expect(consoleSpy.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
          error: `--min-trust must be a whole number between 0 and 4, not ${value}`,
        });
        expect(consoleErrSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(RegistryClient).not.toHaveBeenCalled();
      });
    }

    it('more than 100 packages with --json: {"error"} on stdout, exit 1', async () => {
      const names = Array.from({ length: 101 }, (_, i) => `pkg-${i}`);
      await createProgram().parseAsync(["node", "test", "--json", "batch", ...names]);

      expect(consoleSpy.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
        error:
          "Too many packages (101). The batch API supports a maximum of 100 packages per request.",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(RegistryClient).not.toHaveBeenCalled();
    });
  });

  it("uses formatJson when --json flag is set", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "pkg-a", found: true, trustLevel: 4, verdict: "safe" },
      ],
      meta: { total: 1, found: 1, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "--json", "batch", "pkg-a"]);

    expect(formatJson).toHaveBeenCalled();
  });

  it("sets exit code 2 when packages are below min-trust threshold", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "low-trust-pkg", found: true, trustLevel: 1, verdict: "warning" },
      ],
      meta: { total: 1, found: 1, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "batch", "low-trust-pkg", "--min-trust", "3",
    ]);

    expect(process.exitCode).toBe(2);
  });

  it("does not set exit code when all packages meet min-trust threshold", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "good-pkg", found: true, trustLevel: 4, verdict: "safe" },
      ],
      meta: { total: 1, found: 1, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "batch", "good-pkg", "--min-trust", "3",
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("exits 2 for a name the registry does not have, and the text says so with the check command for it", async () => {
    // The real formatter, so the exit code and the line that gives its
    // reason come from one run.
    const actualFormatter = await vi.importActual<
      typeof import("../output/formatter.js")
    >("../output/formatter.js");
    vi.mocked(formatBatchResults).mockImplementationOnce(actualFormatter.formatBatchResults);
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "my-mcp", found: true, packageType: "mcp_server", trustLevel: 3, verdict: "safe" },
        { name: "nonexistent-xyz-999", found: false, trustLevel: 0, verdict: "unknown" },
      ],
      meta: { total: 2, found: 1, notFound: 1 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    await createProgram().parseAsync(["node", "test", "batch", "my-mcp", "nonexistent-xyz-999"]);

    expect(process.exitCode).toBe(2);
    const lines = String(consoleSpy.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    expect(lines).toContain(
      "  Audit failed: 1 dependency is not in the registry and was not scanned: nonexistent-xyz-999"
    );
    expect(lines).toContain("  Next: ai-trust check nonexistent-xyz-999");
    expect(lines.join("\n")).not.toContain("meets minimum trust level");
  });

  // The registry's answer for a name it does not have carries an all-zero
  // packageId, trust level 0 and verdict "unknown"; --json printed them
  // beside found: false (#276).
  it("prints a name the registry does not have in --json as its name and found: false, with no identifier or level", async () => {
    const found = {
      packageId: "11111111-2222-3333-4444-555555555555",
      name: "my-mcp",
      packageType: "mcp_server",
      trustLevel: 3,
      trustScore: 0.79,
      verdict: "passed",
      scanStatus: "warnings",
      found: true,
    };
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        found,
        {
          packageId: "00000000-0000-0000-0000-000000000000",
          name: "nonexistent-xyz-999",
          packageType: "",
          trustLevel: 0,
          trustScore: 0,
          verdict: "unknown",
          confidence: 0,
          scanStatus: "",
          found: false,
        },
      ],
      meta: { total: 2, found: 1, notFound: 1 },
    });
    vi.mocked(RegistryClient).mockImplementation(function () {
      return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
    });

    await createProgram().parseAsync([
      "node", "test", "--json", "batch", "my-mcp", "nonexistent-xyz-999",
    ]);

    const out = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(out.results).toEqual([found, { name: "nonexistent-xyz-999", found: false }]);
    expect(out.meta).toEqual({ total: 2, found: 1, notFound: 1 });
    // The gate still reads the registry's answer: a missing name exits 2.
    expect(process.exitCode).toBe(2);
  });

  it("sets exit code 1 on API error", async () => {
    const mockBatchQuery = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "batch", "pkg-a"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith("Error: timeout");
  });

  it("prints an API error as one JSON object on stdout when --json is set", async () => {
    const mockBatchQuery = vi
      .fn()
      .mockRejectedValue(new Error("Registry network error: fetch failed"));
    vi.mocked(RegistryClient).mockImplementation(
      function () {
        return { checkTrust: vi.fn(), batchQuery: mockBatchQuery } as any;
      }
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "--json", "batch", "pkg-a"]);

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
      error: "Registry network error: fetch failed",
    });
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });

  describe("a failed registry request names the registry and a next step", () => {
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

    function registryFails(err: Error): ReturnType<typeof vi.fn> {
      const batchQuery = vi.fn().mockRejectedValue(err);
      vi.mocked(RegistryClient).mockImplementation(function () {
        return { checkTrust: vi.fn(), batchQuery } as any;
      });
      return batchQuery;
    }

    function stderrLines(): string[] {
      return consoleErrSpy.mock.calls.map((c) => String(c[0]));
    }

    it("says the registry did not answer, after the retry, and names check for the first package", async () => {
      const batchQuery = registryFails(
        await registryApiError("Registry network error: fetch failed", "network")
      );
      await createProgram().parseAsync([
        "node", "test", "batch", "pkg-a", "pkg-b", "--registry-url", "http://127.0.0.1:9",
      ]);

      expect(stderrLines()).toEqual([
        "Error: Registry network error: fetch failed",
        "  The registry at http://127.0.0.1:9 did not answer.",
        "  Next: run the batch again when the registry answers, or check one package locally with ai-trust check pkg-a",
      ]);
      expect(batchQuery).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
    });

    it("names the status a registry that answered with an error gave", async () => {
      const batchQuery = registryFails(
        await registryApiError("Registry API returned 500", "server_error", 500, "{}")
      );
      await createProgram().parseAsync(["node", "test", "batch", "pkg-a", "pkg-b"]);

      expect(stderrLines()).toEqual([
        "Error: Registry API returned 500",
        "  The registry at https://api.test.com answered 500.",
        "  Next: run the batch again when the registry answers, or check one package locally with ai-trust check pkg-a",
      ]);
      expect(batchQuery).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    it("names the first package as it was looked up, an MCP shorthand expanded", async () => {
      registryFails(await registryApiError("Registry network error: fetch failed", "network"));
      await createProgram().parseAsync([
        "node", "test", "batch", "server-filesystem", "--registry-url", "http://127.0.0.1:9",
      ]);

      expect(stderrLines()).toEqual([
        "Resolved: server-filesystem -> @modelcontextprotocol/server-filesystem",
        "Error: Registry network error: fetch failed",
        "  The registry at http://127.0.0.1:9 did not answer.",
        "  Next: run the batch again when the registry answers, or check one package locally with ai-trust check @modelcontextprotocol/server-filesystem",
      ]);
    });

    it("quotes a first package name with shell syntax in the next step", async () => {
      registryFails(await registryApiError("Registry network error: fetch failed", "network"));
      await createProgram().parseAsync(["node", "test", "batch", "shell-lib; echo injected"]);

      expect(stderrLines()[2]).toBe(
        "  Next: run the batch again when the registry answers, or check one package locally with ai-trust check 'shell-lib; echo injected'"
      );
    });

    it("leaves the --json output as it was: one object on stdout, nothing on stderr", async () => {
      registryFails(await registryApiError("Registry network error: fetch failed", "network"));
      await createProgram().parseAsync([
        "node", "test", "--json", "batch", "pkg-a", "--registry-url", "http://127.0.0.1:9",
      ]);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
        error: "Registry network error: fetch failed",
      });
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("adds no registry line for an error the registry client did not raise", async () => {
      registryFails(new Error("unexpected failure"));
      await createProgram().parseAsync(["node", "test", "batch", "pkg-a"]);

      expect(stderrLines()).toEqual(["Error: unexpected failure"]);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("a registry error that quotes a URL with a user name and password (#232)", () => {
    // Placeholder userinfo: the test needs a URL with user:password@ in it.
    const PLANTED_NAME = "FAKE-USER";
    const PLANTED_WORD = "FAKE-PASSWORD";
    const QUOTED =
      "Registry network error: Request cannot be constructed from a URL that includes credentials: ";
    const REDACTED = `${QUOTED}http://[redacted]@127.0.0.1:9/api/v1/trust/batch`;

    function registryFails(): string[] {
      const url = "http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:9";
      vi.mocked(RegistryClient).mockImplementation(function () {
        return {
          checkTrust: vi.fn(),
          batchQuery: vi.fn().mockRejectedValue(new Error(`${QUOTED}${url}/api/v1/trust/batch`)),
        } as any;
      });
      return ["--registry-url", url];
    }

    function printed(): string {
      return [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls].map((c) => String(c[0])).join("\n");
    }

    it("prints the error line with [redacted] in place of them", async () => {
      await createProgram().parseAsync(["node", "test", ...registryFails(), "batch", "pkg-a"]);

      expect(consoleErrSpy.mock.calls.map((c) => String(c[0]))).toEqual([`Error: ${REDACTED}`]);
      expect(printed()).not.toContain(PLANTED_NAME);
      expect(printed()).not.toContain(PLANTED_WORD);
      expect(process.exitCode).toBe(1);
    });

    it("--json: the error string has [redacted] in place of them", async () => {
      await createProgram().parseAsync(["node", "test", "--json", ...registryFails(), "batch", "pkg-a"]);

      expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({ error: REDACTED });
      expect(printed()).not.toContain(PLANTED_NAME);
      expect(printed()).not.toContain(PLANTED_WORD);
      expect(process.exitCode).toBe(1);
    });
  });
});
