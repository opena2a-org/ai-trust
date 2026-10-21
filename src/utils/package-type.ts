/**
 * Package types: the `--type` option of `check` and `batch`, and the name
 * text output gives each type.
 *
 * The registry looks a package up by name and type when a type is given, and
 * its packages are of the AI-native types and of the library type. A value
 * such as `banana` matched no package, so a registered package was reported
 * as missing. A value that is not one of these types is refused before any
 * request.
 */

import { AI_NATIVE_PACKAGE_TYPES, LIBRARY_PACKAGE_TYPE } from "@opena2a/ai-classifier";

/** The package types `--type` accepts, as the classifier names them. */
export const PACKAGE_TYPES: readonly string[] = [...AI_NATIVE_PACKAGE_TYPES, LIBRARY_PACKAGE_TYPE];

/** The accepted values, for the help text of `--type`. */
export function packageTypeChoices(): string {
  return `one of ${PACKAGE_TYPES.join(", ")}`;
}

/**
 * The error message for a `--type` value that is not a package type, or
 * undefined when no type was given or the type is one of PACKAGE_TYPES.
 */
export function packageTypeProblem(value: string | undefined): string | undefined {
  if (value === undefined || PACKAGE_TYPES.includes(value)) return undefined;
  return `--type must be ${packageTypeChoices()}; got ${JSON.stringify(value)}`;
}

/**
 * The name text output gives each package type, in the words of the batch
 * and audit line "ai-trust covers MCP servers, A2A agents, skills, AI tools,
 * and LLMs.". `--type`, the lines that name a `--type` value and `--json`
 * keep the identifiers.
 */
const PACKAGE_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ["mcp_server", "MCP server"],
  ["a2a_agent", "A2A agent"],
  ["skill", "skill"],
  ["ai_tool", "AI tool"],
  ["llm", "LLM"],
  ["library", "library"],
]);

/**
 * The name of a registry package type in text output: the check header and
 * the TYPE column of batch and audit. A type that is not one of
 * PACKAGE_TYPE_NAMES prints as the registry sent it. An empty string, or a
 * value that is not a string, has no name: the registry answer is remote
 * data, whatever its declared type says.
 */
export function packageTypeName(type: unknown): string | undefined {
  if (typeof type !== "string" || type === "") return undefined;
  return PACKAGE_TYPE_NAMES.get(type) ?? type;
}

/**
 * The scanner's project kinds whose word differs from the name of the
 * package type they are, by that package type.
 */
const SCANNER_KIND_TYPES: ReadonlyMap<string, string> = new Map([["mcp", "mcp_server"]]);

/**
 * The name of the project kind the scanner reports for what it scanned, in
 * the Surfaces line and the verdict of a scan: the scanner's `mcp` prints as
 * the package type's name, MCP server, and its other kinds (`openclaw`,
 * `api`, `cli`, `library`) as the scanner names them.
 */
export function scanKindName(kind: string): string {
  const type = SCANNER_KIND_TYPES.get(kind);
  return type === undefined ? kind : (packageTypeName(type) ?? kind);
}
