/**
 * MCP package name shorthand resolution.
 *
 * Converts short forms like "server-filesystem" or "mcp-server-fetch"
 * into the full scoped name "@modelcontextprotocol/server-*".
 */

const MCP_SCOPE = "@modelcontextprotocol";

/**
 * Resolve a package name, expanding MCP shorthand if applicable.
 *
 * Rules (applied in order):
 * 1. Starts with `@` -- use as-is (already scoped).
 * 2. Starts with `server-` -- prefix with @modelcontextprotocol/.
 * 3. Starts with `mcp/server-` or `mcp-server-` -- convert to @modelcontextprotocol/server-*.
 * 4. Otherwise -- use as-is (regular npm package).
 */
export function resolvePackageName(name: string): string {
  // Rule 1: already scoped
  if (name.startsWith("@")) {
    return name;
  }

  // Rule 2: server-* shorthand (must have at least one char after "server-")
  if (name.startsWith("server-") && name.length > "server-".length) {
    return `${MCP_SCOPE}/${name}`;
  }

  // Rule 3a: mcp/server-* notation (must have at least one char after "mcp/server-")
  if (name.startsWith("mcp/server-") && name.length > "mcp/server-".length) {
    const serverPart = name.slice("mcp/".length);
    return `${MCP_SCOPE}/${serverPart}`;
  }

  // Rule 3b: mcp-server-* notation (must have at least one char after "mcp-server-")
  if (name.startsWith("mcp-server-") && name.length > "mcp-server-".length) {
    const serverPart = name.slice("mcp-".length);
    return `${MCP_SCOPE}/${serverPart}`;
  }

  // Rule 4: regular package
  return name;
}

/**
 * Resolve a package name and log a note if resolution changed it.
 * Returns the resolved name.
 */
export function resolveAndLog(name: string): string {
  const resolved = resolvePackageName(name);
  if (resolved !== name) {
    console.error(`Resolved: ${name} -> ${resolved}`);
  }
  return resolved;
}
