import { describe, it, expect, vi } from "vitest";
import { resolvePackageName, resolveAndLog } from "./resolve.js";

describe("resolvePackageName", () => {
  it("passes through scoped packages unchanged", () => {
    expect(resolvePackageName("@modelcontextprotocol/server-filesystem")).toBe(
      "@modelcontextprotocol/server-filesystem"
    );
    expect(resolvePackageName("@scope/some-pkg")).toBe("@scope/some-pkg");
  });

  it("expands server-* shorthand", () => {
    expect(resolvePackageName("server-filesystem")).toBe(
      "@modelcontextprotocol/server-filesystem"
    );
    expect(resolvePackageName("server-fetch")).toBe(
      "@modelcontextprotocol/server-fetch"
    );
    expect(resolvePackageName("server-github")).toBe(
      "@modelcontextprotocol/server-github"
    );
  });

  it("expands mcp/server-* notation", () => {
    expect(resolvePackageName("mcp/server-fetch")).toBe(
      "@modelcontextprotocol/server-fetch"
    );
    expect(resolvePackageName("mcp/server-filesystem")).toBe(
      "@modelcontextprotocol/server-filesystem"
    );
  });

  it("passes through mcp-server-* as standalone packages", () => {
    // mcp-server-* are often standalone third-party npm packages,
    // not under the @modelcontextprotocol scope
    expect(resolvePackageName("mcp-server-fetch")).toBe("mcp-server-fetch");
    expect(resolvePackageName("mcp-server-filesystem")).toBe("mcp-server-filesystem");
    expect(resolvePackageName("mcp-server-kubernetes")).toBe("mcp-server-kubernetes");
  });

  it("passes through regular packages unchanged", () => {
    expect(resolvePackageName("express")).toBe("express");
    expect(resolvePackageName("chalk")).toBe("chalk");
    expect(resolvePackageName("some-mcp-tool")).toBe("some-mcp-tool");
  });

  it("does not resolve packages that merely contain 'server' or 'mcp'", () => {
    expect(resolvePackageName("my-server-lib")).toBe("my-server-lib");
    expect(resolvePackageName("mcp-client")).toBe("mcp-client");
    expect(resolvePackageName("fast-mcp")).toBe("fast-mcp");
  });

  // --- Edge cases: bare prefixes ---

  it("handles 'server-' alone (prefix with no suffix)", () => {
    // "server-" matches startsWith("server-") so it resolves,
    // but the result has an empty suffix which is not a valid package.
    // The function should pass it through unchanged.
    expect(resolvePackageName("server-")).toBe("server-");
  });

  it("handles 'mcp/' alone (prefix with no suffix)", () => {
    // "mcp/" does not match "mcp/server-" so it passes through.
    expect(resolvePackageName("mcp/")).toBe("mcp/");
  });

  it("handles 'mcp-server-' alone (prefix with no suffix)", () => {
    // "mcp-server-" passes through as a standalone package name
    expect(resolvePackageName("mcp-server-")).toBe("mcp-server-");
  });

  // --- Edge case: empty string ---

  it("handles empty string", () => {
    expect(resolvePackageName("")).toBe("");
  });

  // --- Edge case: package names with dots ---

  it("handles package names with dots", () => {
    expect(resolvePackageName("server-filesystem.js")).toBe(
      "@modelcontextprotocol/server-filesystem.js"
    );
    // mcp-server-* passes through unchanged (standalone package)
    expect(resolvePackageName("mcp-server-filesystem.js")).toBe(
      "mcp-server-filesystem.js"
    );
  });

  // --- Edge case: multiple slashes ---

  it("handles mcp/ notation with extra path segments", () => {
    // "mcp/server/sub/path" starts with "mcp/server-"? No -- "mcp/server/" != "mcp/server-"
    // So it passes through unchanged.
    expect(resolvePackageName("mcp/server/sub/path")).toBe(
      "mcp/server/sub/path"
    );
  });

  it("handles mcp/server-* with extra slashes in the suffix", () => {
    // "mcp/server-foo/bar" starts with "mcp/server-" so it matches rule 3a.
    // Slices off "mcp/" leaving "server-foo/bar".
    expect(resolvePackageName("mcp/server-foo/bar")).toBe(
      "@modelcontextprotocol/server-foo/bar"
    );
  });

  // --- Edge case: case sensitivity ---

  it("is case-sensitive (uppercase variants are not resolved)", () => {
    // The rules use lowercase prefixes; mixed-case should pass through.
    expect(resolvePackageName("Server-Filesystem")).toBe("Server-Filesystem");
    expect(resolvePackageName("MCP-Server-Fetch")).toBe("MCP-Server-Fetch");
    expect(resolvePackageName("SERVER-FILESYSTEM")).toBe("SERVER-FILESYSTEM");
    expect(resolvePackageName("Mcp/Server-Fetch")).toBe("Mcp/Server-Fetch");
  });

  // --- Edge case: names that look like MCP patterns but are not ---

  it("does not resolve names that merely contain 'server-' in the middle", () => {
    expect(resolvePackageName("my-server-app")).toBe("my-server-app");
    expect(resolvePackageName("server-side-rendering")).toBe(
      "@modelcontextprotocol/server-side-rendering"
    );
  });

  it("does not resolve 'mcp-client' or similar non-server MCP packages", () => {
    expect(resolvePackageName("mcp-client")).toBe("mcp-client");
    expect(resolvePackageName("mcp-utils")).toBe("mcp-utils");
    expect(resolvePackageName("mcp-proxy")).toBe("mcp-proxy");
  });

  // --- Edge case: whitespace and special characters ---

  it("handles names with leading/trailing whitespace", () => {
    // Whitespace-padded names should not accidentally match prefixes.
    expect(resolvePackageName(" server-filesystem")).toBe(
      " server-filesystem"
    );
    expect(resolvePackageName("server-filesystem ")).toBe(
      "@modelcontextprotocol/server-filesystem "
    );
  });

  it("handles names with special characters", () => {
    expect(resolvePackageName("server-@foo")).toBe(
      "@modelcontextprotocol/server-@foo"
    );
  });
});

describe("resolveAndLog", () => {
  it("logs a note when resolution changes the name", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = resolveAndLog("server-filesystem");
    expect(result).toBe("@modelcontextprotocol/server-filesystem");
    expect(spy).toHaveBeenCalledWith(
      "Resolved: server-filesystem -> @modelcontextprotocol/server-filesystem"
    );
    spy.mockRestore();
  });

  it("does not log when name is unchanged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = resolveAndLog("express");
    expect(result).toBe("express");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not log for already-scoped packages", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = resolveAndLog("@modelcontextprotocol/server-filesystem");
    expect(result).toBe("@modelcontextprotocol/server-filesystem");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * Live registry integration tests.
 *
 * These tests make real HTTP requests to the npm registry and verify
 * that resolved package names correspond to actual published packages.
 * Skip in CI by setting RUN_LIVE_TESTS=false or omitting it entirely.
 */
describe("live registry resolution", () => {
  const LIVE =
    process.env.RUN_LIVE_TESTS === "true" ||
    process.env.RUN_LIVE_TESTS === "1";
  const itLive = LIVE ? it : it.skip;

  async function registryLookup(
    pkg: string
  ): Promise<{ status: number; name?: string }> {
    const resolved = resolvePackageName(pkg);
    // npm registry expects scoped packages as @scope%2Fpkg (slash encoded, @ literal)
    const urlPath = resolved.startsWith("@")
      ? resolved.replace("/", "%2F")
      : encodeURIComponent(resolved);
    const url = `https://registry.npmjs.org/${urlPath}`;
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as { name?: string };
      return { status: res.status, name: json.name };
    }
    return { status: res.status };
  }

  itLive(
    "resolves server-filesystem to a real registry package",
    async () => {
      const result = await registryLookup("server-filesystem");
      expect(result.status).toBe(200);
      expect(result.name).toBe("@modelcontextprotocol/server-filesystem");
    },
    15_000
  );

  itLive(
    "resolves server-everything to a real registry package",
    async () => {
      const result = await registryLookup("server-everything");
      expect(result.status).toBe(200);
      expect(result.name).toBe("@modelcontextprotocol/server-everything");
    },
    15_000
  );

  itLive(
    "returns 404 for a nonexistent package",
    async () => {
      const result = await registryLookup("nonexistent-server-xyz-999");
      expect(result.status).toBe(404);
    },
    15_000
  );

  itLive(
    "mcp-server-everything passes through as standalone package name",
    async () => {
      // mcp-server-* no longer resolves to @modelcontextprotocol/*
      // This test verifies the name is used as-is
      const resolved = resolvePackageName("mcp-server-everything");
      expect(resolved).toBe("mcp-server-everything");
    },
    15_000
  );
});
