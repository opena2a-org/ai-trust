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
  scannerNodeVersionProblem: vi.fn().mockReturnValue(null),
  scannerTempDirProblem: vi.fn().mockReturnValue(null),
}));

import { registerCheckCommand } from "./check.js";
import { isHmaAvailable, scanPackage } from "../scanner/index.js";

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

/**
 * A registry that keeps a package under its bare name and has no PyPI
 * package by that name. On 2026-10-21 (UTC) the registry at api.oa2a.org
 * answered so for anthropic: the trust query with `ecosystem=pypi` got 404
 * "Package not found", and the query with no ecosystem got the package
 * (packageType ai_tool, trustLevel 2, verdict listed, scanStatus pending).
 * `miss: "zero-id"` answers the PyPI query with the all-zero package id
 * instead, the other form in which the registry says it has no package.
 */
function bareNameRegistry(
  name: string,
  { miss = "404", verdict = "listed" }: { miss?: "404" | "zero-id"; verdict?: string } = {},
) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.searchParams.has("ecosystem")) {
      return miss === "404"
        ? jsonResponse({ error: "Package not found" }, 404)
        : jsonResponse({ name, packageId: "00000000-0000-0000-0000-000000000000" });
    }
    return jsonResponse({
      name,
      packageId: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
      packageType: "ai_tool",
      verdict,
      trustLevel: 2,
      trustScore: 0.35,
      scanStatus: "pending",
    });
  });
  return { fetchMock, urls };
}

/** A registry that has no package of any name. */
function emptyRegistry() {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    urls.push(new URL(String(input)));
    return jsonResponse({ error: "Package not found" }, 404);
  });
  return { fetchMock, urls };
}

describe("check pip:<name> --no-scan answers for a PyPI package the registry keeps under its bare name", () => {
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

  function stderrText(): string {
    return consoleErrSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
  }

  function stdoutText(): string {
    return consoleSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
  }

  const NOTE =
    "Note: the registry has no PyPI package named anthropic; its answer is for the name anthropic with no ecosystem given.";

  it("check pip:anthropic --no-scan --json asks with ecosystem=pypi, then by the bare name, and prints that answer with exit 0", async () => {
    const registry = bareNameRegistry("anthropic");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "pip:anthropic", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(2);
    expect(registry.urls[0].pathname).toBe("/api/v1/trust/query");
    expect(registry.urls[0].searchParams.get("name")).toBe("anthropic");
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    expect(registry.urls[1].pathname).toBe("/api/v1/trust/query");
    expect(registry.urls[1].searchParams.get("name")).toBe("anthropic");
    expect(registry.urls[1].searchParams.has("ecosystem")).toBe(false);
    const output = printedJson(consoleSpy);
    // The five fields the opena2a-parity contract for pip:anthropic compares.
    expect({
      name: output.name,
      trustLevel: output.trustLevel,
      verdict: output.verdict,
      packageType: output.packageType,
      scanStatus: output.scanStatus,
    }).toEqual({
      name: "anthropic",
      trustLevel: 2,
      verdict: "listed",
      packageType: "ai_tool",
      scanStatus: "pending",
    });
    expect(output.found).toBe(true);
    expect(output.ecosystem).toBe("pypi");
    expect(output).not.toHaveProperty("error");
    expect(stderrText()).toContain(NOTE);
    expect(process.exitCode).toBeUndefined();
  });

  it("reads the all-zero package id for the PyPI query as the same miss", async () => {
    const registry = bareNameRegistry("anthropic", { miss: "zero-id" });
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "pip:anthropic", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(2);
    expect(registry.urls[1].searchParams.has("ecosystem")).toBe(false);
    const output = printedJson(consoleSpy);
    expect(output.found).toBe(true);
    expect(output.verdict).toBe("listed");
    expect(process.exitCode).toBeUndefined();
  });

  it("the bare name's verdict sets the exit code: blocked exits 2", async () => {
    const registry = bareNameRegistry("anthropic", { verdict: "blocked" });
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "pip:anthropic", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(2);
    const output = printedJson(consoleSpy);
    expect(output.found).toBe(true);
    expect(output.verdict).toBe("blocked");
    expect(process.exitCode).toBe(2);
  });

  it("text output prints the note on stderr and the answer on stdout", async () => {
    const registry = bareNameRegistry("anthropic");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "check", "pip:anthropic", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(2);
    expect(stderrText()).toContain(NOTE);
    expect(stdoutText()).toContain("anthropic");
    expect(stdoutText()).not.toContain("not found");
    expect(process.exitCode).toBeUndefined();
  });

  it("a pip: target the registry has under neither query is not found, exit 2, with no note", async () => {
    const registry = emptyRegistry();
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "pip:anthropic", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(2);
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    expect(registry.urls[1].searchParams.has("ecosystem")).toBe(false);
    const output = printedJson(consoleSpy);
    expect(output.found).toBe(false);
    expect(output.ecosystem).toBe("pypi");
    expect(stderrText()).not.toContain("Note: the registry has no PyPI package");
    expect(process.exitCode).toBe(2);
  });

  it("check <name> --no-scan, an npm target, asks once with no ecosystem when the registry has no package", async () => {
    const registry = emptyRegistry();
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "anthropic-probe-missing", "--no-scan",
    ]);

    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].searchParams.has("ecosystem")).toBe(false);
    expect(printedJson(consoleSpy).found).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it("without --no-scan, the PyPI miss goes on to the scan and the bare name is not asked", async () => {
    const registry = bareNameRegistry("anthropic");
    harness.fetchMock = registry.fetchMock;

    await createProgram().parseAsync([
      "node", "test", "--json", "check", "pip:anthropic",
    ]);

    // Only an answer for the PyPI package decides that a scan is skipped.
    expect(registry.urls).toHaveLength(1);
    expect(registry.urls[0].searchParams.get("ecosystem")).toBe("pypi");
    expect(isHmaAvailable).toHaveBeenCalled();
    expect(stderrText()).not.toContain("Note: the registry has no PyPI package");
  });
});
