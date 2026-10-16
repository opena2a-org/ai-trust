/**
 * What `check <target>` names, read once before any lookup.
 *
 * Every later step of `check` (registry lookup, download, scan, text and
 * JSON output, hints, contribution) reads the result instead of the string.
 */

import { parseRichTarget } from "./skill-mcp-check.js";
import { bareEcosystemPrefix, parsePackageTarget, resolvePackageName } from "../utils/resolve.js";

/** A git-style shorthand, `<owner>/<repo>` with no `@scope`. */
const GIT_STYLE_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `<name>@<version>` or `@<scope>/<name>@<version>`, the version holding no `/`. */
const NAME_AT_VERSION = /^(@?[^@]+)@([^@/]+)$/;

/** An npm package. */
export interface NpmTarget {
  kind: "npm";
  ecosystem: "npm";
  /** The package name, without a version. */
  name: string;
  /** The version or tag after the name, when the target gives one. */
  version?: string;
  /**
   * What check looks up, downloads, scans and reports: the name after
   * MCP-shorthand expansion, followed by `@<version>` as typed.
   */
  spec: string;
  /** The name as typed, when it was an MCP shorthand that check expanded. */
  shorthand?: string;
}

/** A git-style `<owner>/<repo>`, which is not an npm package name. */
export interface GitTarget {
  kind: "git";
  ecosystem: "npm";
  name: string;
  spec: string;
}

/** A PyPI package, from a `pip:` target. */
export interface PypiTarget {
  kind: "pypi";
  ecosystem: "pypi";
  name: string;
  spec: string;
}

/** A target that names no package. */
export type InvalidTarget =
  | {
      kind: "invalid";
      /** An empty target, or one of spaces only. */
      reason: "empty";
    }
  | {
      kind: "invalid";
      /** `pip:`, `npm:`, `skill:` or `mcp:` with nothing after it. */
      reason: "no-package-name";
      prefix: "pip:" | "npm:" | "skill:" | "mcp:";
    };

export type PackageTarget = NpmTarget | GitTarget | PypiTarget;

/**
 * A `skill:<name>` or `mcp:<name>` target. The registry's narrative for it is
 * shown when there is one; otherwise check goes on with `fallback`, the name
 * read as a package target.
 */
export type RichTarget = ({ kind: "skill" } | { kind: "mcp" }) & {
  name: string;
  fallback: PackageTarget | InvalidTarget;
};

export type CheckTarget = RichTarget | PackageTarget | InvalidTarget;

/** `skill:` or `mcp:` with nothing after it, ignoring spaces around it. */
function bareRichPrefix(raw: string): "skill:" | "mcp:" | undefined {
  const trimmed = raw.trim();
  return trimmed === "skill:" || trimmed === "mcp:" ? trimmed : undefined;
}

/** Read a `check` argument. */
export function classifyCheckTarget(raw: string): CheckTarget {
  // A bare `skill:` or `mcp:` names nothing to look up, as a bare `pip:` does.
  const richPrefix = bareRichPrefix(raw);
  if (richPrefix) return { kind: "invalid", reason: "no-package-name", prefix: richPrefix };
  const rich = parseRichTarget(raw);
  if (rich) {
    return { kind: rich.artifactType, name: rich.name, fallback: classifyPackageTarget(rich.name) };
  }
  return classifyPackageTarget(raw);
}

/** Read a package target: `pip:<name>`, `npm:<name>` or a bare name. */
function classifyPackageTarget(raw: string): PackageTarget | InvalidTarget {
  if (raw.trim() === "") return { kind: "invalid", reason: "empty" };
  const prefix = bareEcosystemPrefix(raw);
  if (prefix) return { kind: "invalid", reason: "no-package-name", prefix };

  const { name: typed, ecosystem } = parsePackageTarget(raw);
  // MCP shorthand (`server-*` -> `@modelcontextprotocol/server-*`) names npm
  // packages; a pip: target is used as given.
  if (ecosystem === "pypi") return { kind: "pypi", ecosystem, name: typed, spec: typed };

  const spec = resolvePackageName(typed);
  const shorthand = spec !== typed ? { shorthand: typed } : {};
  if (GIT_STYLE_NAME.test(spec)) return { kind: "git", ecosystem, name: spec, spec };
  const versioned = NAME_AT_VERSION.exec(spec);
  if (versioned) {
    return { kind: "npm", ecosystem, name: versioned[1], version: versioned[2], spec, ...shorthand };
  }
  return { kind: "npm", ecosystem, name: spec, spec, ...shorthand };
}

/** The target as a `check` argument: `pip:<name>` for PyPI, the name for npm. */
export function targetArgument(target: PackageTarget): string {
  return target.ecosystem === "pypi" ? `pip:${target.spec}` : target.spec;
}
