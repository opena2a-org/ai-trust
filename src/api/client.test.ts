/**
 * Tests for the Registry API client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RegistryClient, PackageNotFoundError } from "./client.js";
import type { TrustAnswer } from "./client.js";

// Mock the package.json import used for User-Agent
vi.mock("node:module", () => ({
  createRequire: () => () => ({ version: "0.0.0-test" }),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

describe("RegistryClient", () => {
  let client: RegistryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new RegistryClient("https://api.example.com");
  });

  describe("constructor", () => {
    it("strips trailing slashes from the base URL", () => {
      const c = new RegistryClient("https://api.example.com///");
      // We verify via the URL used in fetch
      mockFetch.mockResolvedValue(
        jsonResponse({ name: "test", found: true })
      );
      c.checkTrust("test");
      // The call should use the cleaned URL
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toMatch(/^https:\/\/api\.example\.com\/api\//);
    });
  });

  describe("checkTrust", () => {
    it("builds correct URL with name parameter", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ packageId: "abc", name: "my-pkg", trustLevel: 3, trustScore: 0.8, verdict: "safe" })
      );

      await client.checkTrust("my-pkg");

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/trust/query?");
      expect(calledUrl).toContain("name=my-pkg");
      expect(calledUrl).toContain("includeProfile=true");
      expect(calledUrl).toContain("includeDeps=true");
    });

    it("includes type parameter when provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ packageId: "abc", name: "my-pkg", trustLevel: 3, trustScore: 0.8, verdict: "safe" })
      );

      await client.checkTrust("my-pkg", "mcp_server");

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("type=mcp_server");
    });

    it("omits type parameter when not provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ packageId: "abc", name: "my-pkg", trustLevel: 3, trustScore: 0.8, verdict: "safe" })
      );

      await client.checkTrust("my-pkg");

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain("type=");
    });

    it("sets found=true when packageId is present", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ packageId: "uuid-123", name: "my-pkg", trustLevel: 3, trustScore: 0.8, verdict: "safe" })
      );

      const result = await client.checkTrust("my-pkg");
      expect(result.found).toBe(true);
    });

    it("sets found=false when packageId is missing", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ name: "unknown-pkg", trustLevel: 0, trustScore: 0, verdict: "unknown" })
      );

      const result = await client.checkTrust("unknown-pkg");
      expect(result.found).toBe(false);
    });

    it("sends correct headers", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ name: "test", trustLevel: 0, trustScore: 0, verdict: "unknown" })
      );

      await client.checkTrust("test");

      const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["Accept"]).toBe("application/json");
      expect(headers["User-Agent"]).toMatch(/^ai-trust\//);
    });

    it("throws PackageNotFoundError on 404 response", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ error: "Package not found", verdict: "unknown" }, 404)
      );

      await expect(client.checkTrust("bad-pkg")).rejects.toThrow(
        PackageNotFoundError
      );
      await expect(client.checkTrust("bad-pkg")).rejects.toThrow(
        'Package "bad-pkg" not found in the OpenA2A Registry.'
      );
    });

    it("throws generic error on other non-OK responses", async () => {
      mockFetch.mockResolvedValue(jsonResponse("Server Error", 500));

      await expect(client.checkTrust("any-pkg")).rejects.toThrow(
        "Registry API returned 500"
      );
    });
  });

  describe("batchQuery", () => {
    it("posts to the batch endpoint with correct body", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          results: [
            { packageId: "a", name: "pkg-a", trustLevel: 3, trustScore: 0.8, verdict: "safe" },
          ],
          total: 1,
          queriedAt: "2024-01-01T00:00:00Z",
        })
      );

      await client.batchQuery([{ name: "pkg-a" }]);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/trust/batch");

      const opts = mockFetch.mock.calls[0][1];
      expect(opts?.method).toBe("POST");
      expect(JSON.parse(opts?.body as string)).toEqual({
        packages: [{ name: "pkg-a" }],
      });
    });

    it("computes meta.found and meta.notFound correctly", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          results: [
            { packageId: "a", name: "pkg-a", trustLevel: 3, trustScore: 0.8, verdict: "safe" },
            { name: "pkg-b", trustLevel: 0, trustScore: 0, verdict: "unknown" },
          ],
          total: 2,
          queriedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = await client.batchQuery([
        { name: "pkg-a" },
        { name: "pkg-b" },
      ]);

      expect(result.meta.total).toBe(2);
      expect(result.meta.found).toBe(1);
      expect(result.meta.notFound).toBe(1);
    });

    it("treats null UUID as not found", async () => {
      const NULL_UUID = "00000000-0000-0000-0000-000000000000";
      mockFetch.mockResolvedValue(
        jsonResponse({
          results: [
            { packageId: NULL_UUID, name: "ghost-pkg", trustLevel: 0, trustScore: 0, verdict: "unknown" },
          ],
          total: 1,
          queriedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = await client.batchQuery([{ name: "ghost-pkg" }]);

      expect(result.results[0].found).toBe(false);
      expect(result.meta.found).toBe(0);
      expect(result.meta.notFound).toBe(1);
    });

    it("throws on non-OK response", async () => {
      mockFetch.mockResolvedValue(jsonResponse("Server Error", 500));

      await expect(
        client.batchQuery([{ name: "pkg" }])
      ).rejects.toThrow("Registry API returned 500");
    });
  });
});
