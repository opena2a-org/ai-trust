/**
 * Tests for the batch command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerBatchCommand } from "./batch.js";

vi.mock("../api/client.js", () => ({
  RegistryClient: vi.fn().mockImplementation(() => ({
    batchQuery: vi.fn(),
  })),
}));

vi.mock("../output/formatter.js", () => ({
  formatBatchResults: vi.fn(() => "formatted-batch"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
}));

import { RegistryClient } from "../api/client.js";
import { formatJson } from "../output/formatter.js";

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
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
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
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
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

  it("uses formatJson when --json flag is set", async () => {
    const mockBatchQuery = vi.fn().mockResolvedValue({
      results: [
        { name: "pkg-a", found: true, trustLevel: 4, verdict: "safe" },
      ],
      meta: { total: 1, found: 1, notFound: 0 },
    });
    vi.mocked(RegistryClient).mockImplementation(
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
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
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
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
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
    );

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "batch", "good-pkg", "--min-trust", "3",
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code 1 on API error", async () => {
    const mockBatchQuery = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.mocked(RegistryClient).mockImplementation(
      () => ({ checkTrust: vi.fn(), batchQuery: mockBatchQuery }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "batch", "pkg-a"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith("Error: timeout");
  });
});
