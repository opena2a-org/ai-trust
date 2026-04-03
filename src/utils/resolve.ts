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
 *    This is unambiguous: `server-filesystem` clearly means the MCP server.
 * 3. Starts with `mcp/server-` -- convert to @modelcontextprotocol/server-*.
 * 4. Otherwise -- use as-is. This includes `mcp-server-*` names, which are
 *    often standalone third-party packages (mcp-server-kubernetes, etc.),
 *    NOT under the @modelcontextprotocol scope.
 */
export function resolvePackageName(name: string): string {
  // Rule 1: already scoped
  if (name.startsWith("@")) {
    return name;
  }

  // Rule 2: server-* shorthand (must have at least one char after "server-")
  // Unambiguous: nobody names a non-MCP package "server-filesystem"
  if (name.startsWith("server-") && name.length > "server-".length) {
    return `${MCP_SCOPE}/${name}`;
  }

  // Rule 3: mcp/server-* notation (slash form, explicit scope reference)
  if (name.startsWith("mcp/server-") && name.length > "mcp/server-".length) {
    const serverPart = name.slice("mcp/".length);
    return `${MCP_SCOPE}/${serverPart}`;
  }

  // Rule 4: everything else, including mcp-server-* standalone packages
  // Many popular MCP servers are standalone npm packages (mcp-server-kubernetes,
  // mcp-server-docker, etc.) and should NOT be resolved to @modelcontextprotocol/
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
