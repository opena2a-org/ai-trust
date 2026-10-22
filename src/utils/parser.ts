/**
 * Parsers for dependency files (package.json, requirements.txt).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PackageQuery } from "@opena2a/registry-client";
import {
  auditFileRefusal,
  isRequirementsFile,
  NotAnAuditFileError,
} from "./audit-file.js";

/**
 * The packages a package.json or requirements file lists. Any other file
 * is refused with NotAnAuditFileError before it is read, so none of its
 * lines is looked up as a package name. A path that does not exist, or is
 * a directory, fails on the read with ENOENT or EISDIR.
 */
export async function parseDependencyFile(
  filePath: string
): Promise<PackageQuery[]> {
  const refusal = auditFileRefusal(filePath);
  if (refusal) throw refusal;

  const fileName = basename(filePath);
  const content = await readFile(filePath, "utf-8");
  if (isRequirementsFile(filePath)) {
    return parseRequirementsTxt(content);
  }
  if (fileName === "package.json") {
    return parsePackageJson(content, fileName);
  }
  // Another name that was not there to refuse before the read.
  throw new NotAnAuditFileError(fileName);
}

/**
 * Detect the ecosystem from a dependency file path.
 * Returns "pypi" for a requirements file, "npm" for package.json.
 */
export function detectEcosystem(filePath: string): "npm" | "pypi" {
  return isRequirementsFile(filePath) ? "pypi" : "npm";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON value that is not an object, as a refusal names it: "a string", "an array", "null". */
function jsonValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function notADependencyFile(fileName: string, problem: string): Error {
  return new Error(`${fileName} is not a dependency file: ${problem}. Fix it, then re-run.`);
}

function parsePackageJson(content: string, fileName = "package.json"): PackageQuery[] {
  let pkg: unknown;
  try {
    // A UTF-8 byte order mark is read as U+FEFF, which JSON.parse refuses;
    // npm skips a leading one, so it is dropped here too.
    pkg = JSON.parse(content.startsWith("\uFEFF") ? content.slice(1) : content);
  } catch (err) {
    // A bare parser message ("Expected property name … at position 2") is not
    // actionable. Wrap it with the file context and a concrete fix so the
    // error matches the rest of the tool's guidance style (release-test P3).
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${fileName} is not valid JSON (${detail}). ` +
        `Fix the syntax — common causes are trailing commas, unquoted keys, or an unclosed brace — then re-run. ` +
        `Validate it with: node -e "JSON.parse(require('fs').readFileSync('${fileName}','utf8'))"`,
    );
  }

  // Only the names are read: the keys of the dependencies and devDependencies
  // objects, whatever their versions are. A file not shaped that way is
  // refused before anything is looked up, since Object.keys reads the indices
  // of a string or an array ("0", "1", ...) as package names and finds none
  // in a number or a boolean.
  if (!isJsonObject(pkg)) {
    throw notADependencyFile(fileName, `the top level is ${jsonValueKind(pkg)}, not an object`);
  }

  const packages: PackageQuery[] = [];
  const seen = new Set<string>();

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    // A field set to null is read as absent, as a missing one is.
    if (deps === undefined || deps === null) continue;
    if (!isJsonObject(deps)) {
      throw notADependencyFile(
        fileName,
        `"${field}" is ${jsonValueKind(deps)}, not an object of package names`
      );
    }
    for (const name of Object.keys(deps)) {
      if (!seen.has(name)) {
        seen.add(name);
        packages.push({ name });
      }
    }
  }

  return packages;
}

function parseRequirementsTxt(content: string): PackageQuery[] {
  const packages: PackageQuery[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#") || line.startsWith("-")) {
      continue;
    }

    // Extract package name (before version specifiers)
    const match = line.match(/^([a-zA-Z0-9_-]+(?:\[[a-zA-Z0-9_,-]+\])?)/);
    if (match) {
      // Strip extras like [security] from requests[security]
      const name = match[1].replace(/\[.*\]/, "");
      if (!seen.has(name)) {
        seen.add(name);
        packages.push({ name, ecosystem: "pypi" });
      }
    }
  }

  return packages;
}
