/**
 * Parsers for dependency files (package.json, requirements.txt).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PackageQuery } from "../api/client.js";

export async function parseDependencyFile(
  filePath: string
): Promise<PackageQuery[]> {
  const fileName = basename(filePath);
  const content = await readFile(filePath, "utf-8");

  if (fileName === "package.json") {
    return parsePackageJson(content);
  }

  if (fileName === "requirements.txt") {
    return parseRequirementsTxt(content);
  }

  throw new Error(
    `Unsupported dependency file: ${fileName}. Supported: package.json, requirements.txt`
  );
}

function parsePackageJson(content: string): PackageQuery[] {
  const pkg = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

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
        packages.push({ name });
      }
    }
  }

  return packages;
}
