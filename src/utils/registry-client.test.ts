/**
 * AIT-01 — registry-client timeout hardening.
 *
 * These tests drive the REAL `@opena2a/registry-client` 0.2.0 through the
 * shared factory with an injected fetch, so every retry claim is proven by
 * the transport actually being invoked (or not), never by reading a
 * configuration constant.
 */

import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackageNotFoundError } from "@opena2a/registry-client";
import {
  createRegistryClient,
  REGISTRY_TIMEOUT_MS,
  REGISTRY_RETRY_BACKOFF_MS,
} from "./registry-client.js";

const BASE_URL = "https://registry.test.invalid";
const USER_AGENT = "ai-trust/test";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A trust answer of the shape the check pipeline consumes. */
function trustAnswerBody(name = "retry-probe-mcp") {
  return {
    name,
    // `found` is DERIVED by the client, not trusted from the body:
    // client.js sets `data.found = !!data.packageId && data.packageId !== NULL_UUID`.
    // A fixture without a real packageId therefore always resolves found:false,
    // which is what made these cells fail on their first host run.
    packageId: "11111111-2222-3333-4444-555555555555",
    found: true,
    verdict: "safe",
    trustLevel: 3,
    trustScore: 0.9,
    packageType: "mcp_server",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What an aborted fetch rejects with when the client's timeout fires. */
function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

function buildClient(fetchMock: ReturnType<typeof vi.fn>) {
  return createRegistryClient({
    baseUrl: BASE_URL,
    userAgent: USER_AGENT,
    fetch: fetchMock as unknown as typeof fetch,
    retryBackoffMs: 0,
  });
}

/** All shipped .ts sources under src/, excluding *.test.ts. */
function shippedSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...shippedSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe("AIT-01 registry-client timeout hardening", () => {
  it("AIT-01.AC1 exactly one construction site, in the shared factory, with explicit timeoutMs 15000; all six former sites use the factory", async () => {
    // Behavioral: the factory-built client carries the explicit 15000 ms
    // timeout (the dependency would default to 10000 without it).
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(trustAnswerBody()));
    const client = buildClient(fetchMock);
    expect((client as unknown as { timeoutMs?: number }).timeoutMs).toBe(15000);
    expect(REGISTRY_TIMEOUT_MS).toBe(15000);

    // Census: under src/, excluding *.test.ts, "new RegistryClient(" occurs
    // exactly once, and that occurrence is inside the factory module.
    const occurrences: Array<{ file: string; count: number }> = [];
    for (const file of shippedSources(SRC_DIR)) {
      const count = countOccurrences(
        readFileSync(file, "utf8"),
        "new RegistryClient(",
      );
      if (count > 0) occurrences.push({ file, count });
    }
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].count).toBe(1);
    expect(occurrences[0].file.split(path.sep).slice(-2).join("/")).toBe(
      "utils/registry-client.ts",
    );

    // The six former construction sites (check.ts x3, audit.ts x2,
    // batch.ts x1) all obtain their client from the factory now.
    const formerSites: Array<[string, number]> = [
      ["commands/check.ts", 3],
      ["commands/audit.ts", 2],
      ["commands/batch.ts", 1],
    ];
    for (const [rel, expectedCalls] of formerSites) {
      const source = readFileSync(path.join(SRC_DIR, rel), "utf8");
      expect(countOccurrences(source, "new RegistryClient(")).toBe(0);
      expect(
        countOccurrences(source, "createRegistryClient("),
      ).toBeGreaterThanOrEqual(expectedCalls);
      expect(source).toContain('from "../utils/registry-client.js"');
    }
  });

  it("AIT-01.AC2 a lookup that times out once succeeds on the retry (transport called exactly twice)", async () => {
    const answer = trustAnswerBody();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockImplementationOnce(async () => jsonResponse(answer));
    const client = buildClient(fetchMock);

    const result = await client.checkTrust("retry-probe-mcp");
    expect(result).toMatchObject(answer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("AIT-01.AC3 a lookup that fails once with a transport-level network error succeeds on the retry", async () => {
    const answer = trustAnswerBody();
    // What undici throws when the connection itself dies — the dependency
    // mints RegistryApiError code "network" for it (vs "timeout" for aborts).
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(async () => jsonResponse(answer));
    const client = buildClient(fetchMock);

    const result = await client.checkTrust("retry-probe-mcp");
    expect(result).toMatchObject(answer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("AIT-01.AC4 an answering registry is never retried: 404 and 400/401/403/503 each record exactly one invocation", async () => {
    // 404 → PackageNotFoundError propagates unchanged, no retry.
    const notFoundFetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: "not_found" }, 404));
    const notFoundClient = buildClient(notFoundFetch);
    await expect(notFoundClient.checkTrust("missing-mcp")).rejects.toBeInstanceOf(
      PackageNotFoundError,
    );
    expect(notFoundFetch).toHaveBeenCalledTimes(1);

    // Other non-ok statuses → RegistryApiError with the classified code,
    // still exactly one invocation each. A registry that answers is the
    // registry working; retrying it would double load on a live service.
    const cases: Array<[number, string]> = [
      [400, "bad_request"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [503, "server_error"],
    ];
    for (const [status, expectedCode] of cases) {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ error: "nope" }, status));
      const client = buildClient(fetchMock);

      let caught: unknown;
      try {
        await client.checkTrust("retry-probe-mcp");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(PackageNotFoundError);
      expect((caught as Error & { code?: string }).code).toBe(expectedCode);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("AIT-01.AC5 the retry is bounded at exactly one extra attempt and the timeout error surfaces", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw abortError();
    });
    const client = buildClient(fetchMock);

    let caught: unknown;
    try {
      await client.checkTrust("retry-probe-mcp");
    } catch (err) {
      caught = err;
    }
    // Never 3+ attempts — no retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The RegistryApiError code "timeout" surfaces rather than being
    // swallowed, and its message carries the explicit 15000 ms budget.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe("timeout");
    expect((caught as Error).message).toContain("15000");
    // Worst case per lookup: 15000 + 500 + 15000 = 30500 ms.
    expect(REGISTRY_RETRY_BACKOFF_MS).toBe(500);
  });

  it("AIT-01.AC6 control: a first-attempt success records exactly one invocation, so the counter can distinguish a fired retry", async () => {
    const answer = trustAnswerBody();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(answer));
    const client = buildClient(fetchMock);

    const result = await client.checkTrust("retry-probe-mcp");
    expect(result).toMatchObject(answer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("AIT-01.AC8 the fix adds no dependency: registry-client stays pinned at 0.2.0 and the dependency list is unchanged", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(SRC_DIR, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@opena2a/registry-client"]).toBe("0.2.0");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      [
        "@opena2a/ai-classifier",
        "@opena2a/check-core",
        "@opena2a/cli-ui",
        "@opena2a/contribute",
        "@opena2a/registry-client",
        "@opena2a/shared",
        "@opena2a/telemetry",
        "chalk",
        "commander",
        "hackmyagent",
      ].sort(),
    );
  });
});
