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

  it("expands mcp-server-* notation", () => {
    expect(resolvePackageName("mcp-server-fetch")).toBe(
      "@modelcontextprotocol/server-fetch"
    );
    expect(resolvePackageName("mcp-server-filesystem")).toBe(
      "@modelcontextprotocol/server-filesystem"
    );
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
