/**
 * Tests for the check command logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerCheckCommand } from "./check.js";

// Mock the API client, preserving the real PackageNotFoundError class
vi.mock("../api/client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    RegistryClient: vi.fn().mockImplementation(() => ({
      checkTrust: vi.fn(),
    })),
  };
});

// Mock formatter
vi.mock("../output/formatter.js", () => ({
  formatCheckResult: vi.fn(() => "formatted-check-result"),
  formatJson: vi.fn((data: unknown) => JSON.stringify(data)),
}));

import { RegistryClient, PackageNotFoundError } from "../api/client.js";
import { formatCheckResult, formatJson } from "../output/formatter.js";

function createProgram(): Command {
  const program = new Command();
  program
    .option("--registry-url <url>", "registry base URL", "https://api.test.com")
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
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "check", "my-pkg", "-t", "mcp_server"]);

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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "--json", "check", "my-pkg"]);

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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
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
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "check", "good-pkg"]);

    expect(process.exitCode).toBeUndefined();
  });

  it("shows friendly error for 404 (package not found)", async () => {
    const mockCheckTrust = vi.fn().mockRejectedValue(
      new PackageNotFoundError("nonexistent-pkg")
    );
    vi.mocked(RegistryClient).mockImplementation(
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "check", "nonexistent-pkg"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      'Error: Package "nonexistent-pkg" not found in the OpenA2A Registry.'
    );
  });

  it("sets exit code 1 on API error", async () => {
    const mockCheckTrust = vi.fn().mockRejectedValue(new Error("network failure"));
    vi.mocked(RegistryClient).mockImplementation(
      () => ({ checkTrust: mockCheckTrust, batchQuery: vi.fn() }) as any
    );

    const program = createProgram();
    await program.parseAsync(["node", "test", "check", "any-pkg"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith("Error: network failure");
  });
});
