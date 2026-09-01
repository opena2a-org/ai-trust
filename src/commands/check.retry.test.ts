/**
 * AIT-01.AC7 — the user-facing check output no longer degrades on a single
 * transient registry failure.
 *
 * This drives the REAL check command, the REAL shared factory and the REAL
 * `@opena2a/registry-client` end to end; only the transport is injected.
 * The factory module is wrapped (not replaced) so the command's own
 * construction path runs with the test's fetch and a zero backoff.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const harness = vi.hoisted(() => ({
  fetchMock: undefined as undefined | ((...args: unknown[]) => Promise<Response>),
}));

vi.mock("../utils/registry-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/registry-client.js")>();
  return {
    ...actual,
    createRegistryClient: (
      options: Parameters<typeof actual.createRegistryClient>[0],
    ) =>
      actual.createRegistryClient({
        ...options,
        fetch: ((...args: unknown[]) =>
          harness.fetchMock!(...args)) as unknown as typeof fetch,
        retryBackoffMs: 0,
      }),
  };
});

// Keep the scanner out of the module graph — --no-scan never reaches it.
vi.mock("../scanner/index.js", () => ({
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  scanPackage: vi.fn(),
  scanLocalPath: vi.fn(),
}));

import { registerCheckCommand } from "./check.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

function createProgram(): Command {
  const program = new Command();
  program
    .option(
      "--registry-url <url>",
      "registry base URL",
      "https://registry.test.invalid",
    )
    .option("--json", "output raw JSON", false);
  registerCheckCommand(program);
  return program;
}

describe("check command transient-failure resilience", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    process.exitCode = savedExitCode;
    harness.fetchMock = undefined;
  });

  it("AIT-01.AC7 check --no-scan --json survives one transient timeout: full answer, no error key, exit code unset", async () => {
    const answer = {
      name: "retry-probe-mcp",
      // Derived by the client from packageId (see registry-client.test.ts note).
      packageId: "11111111-2222-3333-4444-555555555555",
      found: true,
      verdict: "safe",
      trustLevel: 3,
      trustScore: 0.9,
      packageType: "mcp_server",
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockImplementationOnce(async () => jsonResponse(answer));
    harness.fetchMock = fetchMock;

    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "check",
      "retry-probe-mcp",
      "--no-scan",
    ]);

    // The retry actually fired at the transport.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The printed JSON is the full trust answer, not the degraded
    // buildNotFoundOutput({ error: ... }) block.
    const printed = consoleSpy.mock.calls.at(-1)?.[0] as string;
    const output = JSON.parse(printed) as Record<string, unknown>;
    expect(output.found).toBe(true);
    expect(output.name).toBe("retry-probe-mcp");
    expect(output.verdict).toBe("safe");
    expect(output.trustLevel).toBe(3);
    expect(output.trustScore).toBe(0.9);
    expect(output).not.toHaveProperty("error");

    // The degraded path sets process.exitCode = 1; the survived lookup
    // must not.
    expect(process.exitCode).not.toBe(1);
    expect(process.exitCode).toBeUndefined();
  });
});
