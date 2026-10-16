import { describe, expect, it } from "vitest";
import { classifyCheckTarget, targetArgument, type CheckTarget } from "./target.js";

const npm = (spec: string, extra: Record<string, string> = {}): CheckTarget => ({
  kind: "npm",
  ecosystem: "npm",
  name: spec,
  spec,
  ...extra,
});
const pypi = (name: string): CheckTarget => ({ kind: "pypi", ecosystem: "pypi", name, spec: name });
const git = (name: string): CheckTarget => ({ kind: "git", ecosystem: "npm", name, spec: name });

describe("classifyCheckTarget", () => {
  const cases: Array<[string, string, CheckTarget]> = [
    ["bare npm name", "table-tool", npm("table-tool")],
    ["@scope/name", "@table/agent", npm("@table/agent")],
    [
      "name@version",
      "table-tool@1.2.3",
      { kind: "npm", ecosystem: "npm", name: "table-tool", version: "1.2.3", spec: "table-tool@1.2.3" },
    ],
    [
      "@scope/name@version",
      "@table/agent@2.0.0",
      { kind: "npm", ecosystem: "npm", name: "@table/agent", version: "2.0.0", spec: "@table/agent@2.0.0" },
    ],
    ["name@tag", "table-tool@latest", { kind: "npm", ecosystem: "npm", name: "table-tool", version: "latest", spec: "table-tool@latest" }],
    ["npm:name", "npm:table-tool", npm("table-tool")],
    ["pip:name", "pip:table-pylib", pypi("table-pylib")],
    ["pip: with nothing after", "pip:", { kind: "invalid", reason: "no-package-name", prefix: "pip:" }],
    ["npm: with nothing after", "npm:", { kind: "invalid", reason: "no-package-name", prefix: "npm:" }],
    ["pip: with spaces around", " pip: ", { kind: "invalid", reason: "no-package-name", prefix: "pip:" }],
    ["empty", "", { kind: "invalid", reason: "empty" }],
    ["spaces only", "   ", { kind: "invalid", reason: "empty" }],
    ["<owner>/<repo>", "table-owner/table-repo", git("table-owner/table-repo")],
    ["npm:<owner>/<repo>", "npm:table-owner/table-repo", git("table-owner/table-repo")],
    // A pip: target is not an npm name, so it is never read as git-style.
    ["pip:<owner>/<repo>", "pip:table-owner/table-repo", pypi("table-owner/table-repo")],
    [
      "MCP shorthand server-*",
      "server-table",
      npm("@modelcontextprotocol/server-table", { shorthand: "server-table" }),
    ],
    [
      "MCP shorthand mcp/server-*",
      "mcp/server-table",
      npm("@modelcontextprotocol/server-table", { shorthand: "mcp/server-table" }),
    ],
    [
      "MCP shorthand with a version",
      "server-table@1.0.0",
      {
        kind: "npm",
        ecosystem: "npm",
        name: "@modelcontextprotocol/server-table",
        version: "1.0.0",
        spec: "@modelcontextprotocol/server-table@1.0.0",
        shorthand: "server-table@1.0.0",
      },
    ],
    ["npm:server-*", "npm:server-table", npm("@modelcontextprotocol/server-table", { shorthand: "server-table" })],
    // MCP shorthand names npm packages; a pip: target is used as given.
    ["pip:server-*", "pip:server-table", pypi("server-table")],
    // `mcp/server-` with nothing after is not expanded, and is git-style.
    ["mcp/server- with nothing after", "mcp/server-", git("mcp/server-")],
    ["mcp-server-* is not a shorthand", "mcp-server-kubernetes", npm("mcp-server-kubernetes")],
    [
      "skill: target",
      "skill:table-skill",
      { kind: "skill", name: "table-skill", fallback: npm("table-skill") },
    ],
    [
      "mcp: target",
      "mcp:table-tool",
      { kind: "mcp", name: "table-tool", fallback: npm("table-tool") },
    ],
    [
      "mcp: naming an MCP shorthand",
      "mcp:server-table",
      {
        kind: "mcp",
        name: "server-table",
        fallback: npm("@modelcontextprotocol/server-table", { shorthand: "server-table" }),
      },
    ],
    [
      "skill: naming a pip: target",
      "skill:pip:table-py-agent",
      { kind: "skill", name: "pip:table-py-agent", fallback: pypi("table-py-agent") },
    ],
    [
      "mcp: naming pip: with nothing after",
      "mcp:pip:",
      { kind: "mcp", name: "pip:", fallback: { kind: "invalid", reason: "no-package-name", prefix: "pip:" } },
    ],
    // The narrative lookup takes the name as given; only the fallback reads it.
    [
      "skill: naming another prefix",
      "skill:mcp:table-tool",
      { kind: "skill", name: "mcp:table-tool", fallback: npm("mcp:table-tool") },
    ],
    // A bare skill: or mcp: names nothing, as a bare pip: does (#193).
    ["skill: with nothing after", "skill:", { kind: "invalid", reason: "no-package-name", prefix: "skill:" }],
    ["mcp: with nothing after", "mcp:", { kind: "invalid", reason: "no-package-name", prefix: "mcp:" }],
    ["skill: with spaces around", " skill: ", { kind: "invalid", reason: "no-package-name", prefix: "skill:" }],
    ["mcp: with spaces after", "mcp:   ", { kind: "invalid", reason: "no-package-name", prefix: "mcp:" }],
    ["control characters", "\u001b[31mtable-tool", npm("\u001b[31mtable-tool")],
    ["upper case", "Table-Tool", npm("Table-Tool")],
    ["URL", "https://github.com/table-owner/table-repo", npm("https://github.com/table-owner/table-repo")],
    ["URL with a user", "https://user@example.com/x", npm("https://user@example.com/x")],
    ["name ending in @", "table-tool@", npm("table-tool@")],
    ["unknown prefix", "pypi:requests", npm("pypi:requests")],
  ];

  it.each(cases)("%s: %j", (_form, raw, expected) => {
    expect(classifyCheckTarget(raw)).toEqual(expected);
  });

  it("an npm target's spec is its name followed by @<version> when it has one", () => {
    for (const [, raw] of cases) {
      const target = classifyCheckTarget(raw);
      const pkg = target.kind === "skill" || target.kind === "mcp" ? target.fallback : target;
      if (pkg.kind !== "npm") continue;
      expect(pkg.spec).toBe(pkg.version === undefined ? pkg.name : `${pkg.name}@${pkg.version}`);
    }
  });
});

describe("targetArgument", () => {
  it("keeps the pip: prefix of a PyPI target", () => {
    const target = classifyCheckTarget("pip:requests");
    if (target.kind !== "pypi") throw new Error("expected a PyPI target");
    expect(targetArgument(target)).toBe("pip:requests");
  });

  it("gives an npm target as check looks it up", () => {
    const target = classifyCheckTarget("npm:server-table");
    if (target.kind !== "npm") throw new Error("expected an npm target");
    expect(targetArgument(target)).toBe("@modelcontextprotocol/server-table");
  });
});
