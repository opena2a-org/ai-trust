/**
 * Parsers for dependency files (package.json, requirements.txt).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PackageQuery } from "@opena2a/registry-client";

export async function parseDependencyFile(
  filePath: string
): Promise<PackageQuery[]> {
  const fileName = basename(filePath);
  const content = await readFile(filePath, "utf-8");

  // Detect format by filename or extension
  if (fileName.endsWith(".json")) {
    return parsePackageJson(content, fileName);
  }

  if (fileName.endsWith(".txt") || fileName === "requirements") {
    return parseRequirementsTxt(content);
  }

  // Try JSON first, fall back to requirements.txt format
  try {
    JSON.parse(content);
    return parsePackageJson(content, fileName);
  } catch {
    return parseRequirementsTxt(content);
  }
}

/**
 * Detect the ecosystem from a dependency file path.
 * Returns "pypi" for requirements.txt files, "npm" for package.json.
 */
export function detectEcosystem(filePath: string): "npm" | "pypi" {
  const fileName = basename(filePath);
  if (fileName.endsWith(".txt") || fileName === "requirements") {
    return "pypi";
  }
  return "npm";
}

function parsePackageJson(content: string, fileName = "package.json"): PackageQuery[] {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(content);
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

  const packages: PackageQuery[] = [];
  const seen = new Set<string>();

  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    if (!deps) continue;
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
