/**
 * #131 — `check pip:<name>` asks the registry about the PyPI package.
 *
 * This drives the REAL check command, the REAL shared factory and the REAL
 * `@opena2a/registry-client`; only the transport is injected. The fake
 * registry answers a trust query that carries `ecosystem=pypi` with one
 * package and a query without it with another, so the printed verdict and
 * the exit code show which question the command asked.
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

vi.mock("../scanner/index.js", () => ({
  isHmaAvailable: vi.fn().mockResolvedValue(false),
  reinstallCommand: vi.fn().mockReturnValue("npm install -g ai-trust"),
  scanPackage: vi.fn(),
  scanLocalPath: vi.fn(),
  scannerTempDirProblem: vi.fn().mockReturnValue(null),
}));

import { registerCheckCommand } from "./check.js";
import { scanPackage } from "../scanner/index.js";

const NAME = "pyprobe-agent";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A registry that keeps a PyPI package and an npm package under one name:
 * the PyPI one is blocked, the npm one passed.
 */
function fakeRegistry(packageType: string) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    urls.push(url);
    const pypi = url.searchParams.get("ecosystem") === "pypi";
    return jsonResponse({
      name: NAME,
      packageId: pypi
        ? "11111111-2222-3333-4444-555555555555"
        : "66666666-7777-8888-9999-000000000000",
      packageType,
      verdict: pypi ? "blocked" : "passed",
      trustLevel: pypi ? 0 : 3,
      trustScore: pypi ? 0.1 : 0.9,
    });
  });
  return { fetchMock, urls };
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

function printedJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(spy.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
}

describe("check looks a pip: target up as a PyPI package (#131)", () => {
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
    harness.fetchMock = undefined;
  });

  it("check pip:<name> --no-scan sends ecosystem=pypi, and the PyPI answer sets the output and the exit code", async () => {
    const registry = fakeRegistry("ai_tool");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", `pip:${NAME}`, "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].pathname).toBe("/api/v1/trust/query");
    expect(registry.urls[0].searchParams.get("name")).toBe(NAME);
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    const output = printedJson(consoleSpy);
    expect(output.ecosystem).toBe("pypi");
    expect(output.verdict).toBe("blocked");
    expect(process.exitCode).toBe(2);
  });

  it("check pip:<name>@<version> --no-scan asks about <name> with ecosystem=pypi and notes that the answer is the package's (#224)", async () => {
    const registry = fakeRegistry("ai_tool");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", `pip:${NAME}@2.0.0`, "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].searchParams.get("name")).toBe(NAME);
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    const stderr = consoleErrSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(stderr).toContain(
      `Note: the registry's answer is for the package ${NAME}, not for version 2.0.0.`,
    );
    const output = printedJson(consoleSpy);
    expect(output.name).toBe(NAME);
    expect(output.ecosystem).toBe("pypi");
    expect(output.verdict).toBe("blocked");
    expect(process.exitCode).toBe(2);
  });

  it("check <name> --no-scan sends no ecosystem, as before", async () => {
    const registry = fakeRegistry("ai_tool");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", NAME, "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].searchParams.get("name")).toBe(NAME);
    expect(registry.urls[0].searchParams.has("ecosystem")).toBe(false);
    const output = printedJson(consoleSpy);
    expect(output.ecosystem).toBe("npm");
    expect(output.verdict).toBe("passed");
    expect(process.exitCode).toBeUndefined();
  });

  it("check pip:<name> without --no-scan asks with ecosystem=pypi before it decides to scan", async () => {
    const registry = fakeRegistry("library");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", `pip:${NAME}`,
    ]);

    // A registry-classified library is answered from the registry, not scanned.
    expect(scanPackage).not.toHaveBeenCalled();
    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    const output = printedJson(consoleSpy);
    expect((output.registryData as Record<string, unknown>).verdict).toBe("blocked");
    expect(process.exitCode).toBe(2);
  });
});
