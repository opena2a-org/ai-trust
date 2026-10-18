/**
 * How `check` reads each form of its target, end to end.
 *
 * One row per target form, each run through the built CLI four ways: no flag
 * (registry lookup, then download and scan), --no-scan (the registry's answer
 * only), --json, and --no-scan --json. A cell pins the exit code, what the
 * output says (the ecosystem, the out-of-scope or not-found hint and the
 * command it suggests) and which names reached the trust registry, npm and
 * PyPI.
 *
 * Each cell gets its own local server playing the trust registry, the npm
 * registry and PyPI. A preloaded fetch guard sends PyPI's URL to that server
 * and refuses every other host, so the suite runs offline.
 * Exercises the built `dist/index.js`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const CLI_PATH = resolve(__dirname, "../../dist/index.js");
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const SCAN_PACKAGE = "table-scan-pkg";

/** A registry answer for a package the registry knows. */
function known(name: string, packageType: string, verdict: string): Record<string, unknown> {
  return {
    packageId: "11111111-2222-3333-4444-555555555555",
    name,
    packageType,
    trustLevel: verdict === "blocked" ? 0 : 3,
    trustScore: verdict === "blocked" ? 0.2 : 0.9,
    verdict,
    scanStatus: "completed",
    communityScans: 0,
  };
}

/**
 * What the trust registry answers, by the exact name it is asked for. A name
 * not listed is a 404.
 */
const TRUST: Record<string, { status: number; body: Record<string, unknown> }> = {
  "table-tool": { status: 200, body: known("table-tool", "mcp_server", "passed") },
  "table-blocked-tool": { status: 200, body: known("table-blocked-tool", "mcp_server", "blocked") },
  "table-lib": { status: 200, body: known("table-lib", "library", "passed") },
  "table-pylib": { status: 200, body: known("table-pylib", "library", "passed") },
  "@modelcontextprotocol/server-table": {
    status: 200,
    body: known("@modelcontextprotocol/server-table", "mcp_server", "passed"),
  },
  // The all-zero package id is the registry's other way of saying "no data".
  "table-zero-id": { status: 200, body: { packageId: ZERO_ID, name: "table-zero-id" } },
  chalk: { status: 200, body: { packageId: ZERO_ID, name: "chalk" } },
  "table-registry-error": { status: 500, body: { error: "registry failure" } },
};

/** The one narrative the registry holds: a skill. */
const SKILL_NARRATIVE = {
  artifactType: "skill",
  packageName: "table-skill",
  packageVersion: "1.0.0",
  schemaVersion: 1,
  generatedAt: "2026-10-01T00:00:00Z",
  summary: "A skill the table test reads.",
  hardcodedSecrets: { detected: [], scanCovered: true },
  skill: { skillName: "table-skill" },
  verdictReasoning: [],
  nextSteps: [],
};

const MODES = {
  "no flag": [],
  "--no-scan": ["--no-scan"],
  "--json": ["--json"],
  "--no-scan --json": ["--no-scan", "--json"],
} as const;
type Mode = keyof typeof MODES;

interface Observed {
  status: number | null;
  stdout: string;
  stderr: string;
  /** What reached the local server, in order: `trust <name>`, `npm <path>`, ... */
  requests: string[];
}

interface Cell {
  exit: number;
  /** Text that the output (stdout and stderr together) shows. */
  shows?: string[];
  /** Fields of the JSON document on stdout. */
  json?: Record<string, unknown>;
  requests: string[];
}

interface Row {
  form: string;
  target: string;
  cells: Record<Mode, Cell>;
}

const ROWS: Row[] = [
  {
    form: "bare npm name, registry answer in scope",
    target: "table-tool",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-tool (npm)", "→ Scan locally  ai-trust check table-tool", "Scanning table-tool..."],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["table-tool  mcp server", "No known issues", "→ Fresh scan  ai-trust check table-tool"],
        requests: ["trust table-tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-tool\": Package \"table-tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-tool..."],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-tool", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        requests: ["trust table-tool"],
      },
    },
  },
  {
    form: "bare npm name, registry verdict blocked",
    target: "table-blocked-tool",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-blocked-tool (npm)", "→ Scan locally  ai-trust check table-blocked-tool", "Scanning table-blocked-tool..."],
        requests: ["trust table-blocked-tool", "npm /table-blocked-tool"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["table-blocked-tool  mcp server", "Blocked by registry", "→ Scan locally  ai-trust check table-blocked-tool"],
        requests: ["trust table-blocked-tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-blocked-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-blocked-tool\": Package \"table-blocked-tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-blocked-tool..."],
        requests: ["trust table-blocked-tool", "npm /table-blocked-tool"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-blocked-tool", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "blocked"},
        requests: ["trust table-blocked-tool"],
      },
    },
  },
  {
    form: "bare npm name, registry library",
    target: "table-lib",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["table-lib  library (registry-classified)", "Out of scope for ai-trust — the registry classifies this as a general-purpose library.", "npx hackmyagent check table-lib"],
        requests: ["trust table-lib"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["table-lib  library (registry-classified)", "Out of scope for ai-trust — the registry classifies this as a general-purpose library.", "npx hackmyagent check table-lib"],
        requests: ["trust table-lib"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-lib", "ecosystem": "npm", "found": true, "outOfScope": true, "nextSteps": ["npx hackmyagent check table-lib"]},
        requests: ["trust table-lib"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-lib", "ecosystem": "npm", "found": true, "outOfScope": true, "nextSteps": ["npx hackmyagent check table-lib"]},
        requests: ["trust table-lib"],
      },
    },
  },
  {
    form: "bare npm name, library by name with no registry data",
    target: "express",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: express (npm)", "→ Scan locally  ai-trust check express", "Scanning express..."],
        requests: ["trust express", "npm /express"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["express  library (by name — no registry data)", "Out of scope for ai-trust — ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).", "npx hackmyagent check express"],
        requests: ["trust express"],
      },
      "--json": {
        exit: 2,
        json: {"name": "express", "ecosystem": "npm", "found": false, "error": "Failed to download \"express\": Package \"express\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning express..."],
        requests: ["trust express", "npm /express"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "express", "ecosystem": "npm", "found": false, "outOfScope": true, "nextSteps": ["npx hackmyagent check express"]},
        requests: ["trust express"],
      },
    },
  },
  // After a scan that found no such package, the not-found block still offers
  // the command that just ran as its first next step (#123).
  {
    form: "bare npm name, no registry data",
    target: "table-missing",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-missing (npm)", "→ Scan locally  ai-trust check table-missing", "Scanning table-missing..."],
        requests: ["trust table-missing", "npm /table-missing"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-missing (npm)", "→ Scan locally  ai-trust check table-missing"],
        requests: ["trust table-missing"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-missing", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-missing\": Package \"table-missing\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-missing..."],
        requests: ["trust table-missing", "npm /table-missing"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-missing", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-missing", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-missing\" not found in the OpenA2A Registry."},
        requests: ["trust table-missing"],
      },
    },
  },
  {
    form: "bare npm name the local npm registry serves",
    target: "table-scan-pkg",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["Scanning table-scan-pkg...", "table-scan-pkg  downloaded package"],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg (npm)", "→ Scan locally  ai-trust check table-scan-pkg"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-scan-pkg", "ecosystem": "npm", "source": "scan", "found": true, "verdict": "safe"},
        shows: ["Scanning table-scan-pkg..."],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  {
    form: "@scope/name",
    target: "@table/agent",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: @table/agent (npm)", "→ Scan locally  ai-trust check @table/agent", "Scanning @table/agent..."],
        requests: ["trust @table/agent", "npm /@table%2fagent"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: @table/agent (npm)", "→ Scan locally  ai-trust check @table/agent"],
        requests: ["trust @table/agent"],
      },
      "--json": {
        exit: 2,
        json: {"name": "@table/agent", "ecosystem": "npm", "found": false, "error": "Failed to download \"@table/agent\": Package \"@table/agent\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning @table/agent..."],
        requests: ["trust @table/agent", "npm /@table%2fagent"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "@table/agent", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check @table/agent", "npx hackmyagent secure <project-dir>"], "error": "Package \"@table/agent\" not found in the OpenA2A Registry."},
        requests: ["trust @table/agent"],
      },
    },
  },
  // The registry is asked about a versioned target by the package name alone;
  // npm is asked for the package at that version.
  {
    form: "name@version",
    target: "table-tool@1.2.3",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Scanning table-tool@1.2.3...", "Package not found: table-tool@1.2.3 (npm)", "→ Scan locally  ai-trust check table-tool@1.2.3"],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["Note: the registry's answer is for the package table-tool, not for version 1.2.3.", "table-tool  mcp server", "No known issues", "→ Fresh scan  ai-trust check table-tool"],
        requests: ["trust table-tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-tool@1.2.3", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-tool@1.2.3\": Package \"table-tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-tool@1.2.3..."],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-tool", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        shows: ["Note: the registry's answer is for the package table-tool, not for version 1.2.3."],
        requests: ["trust table-tool"],
      },
    },
  },
  {
    form: "@scope/name@version",
    target: "@table/agent@2.0.0",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Scanning @table/agent@2.0.0...", "Package not found: @table/agent@2.0.0 (npm)", "→ Scan locally  ai-trust check @table/agent@2.0.0"],
        requests: ["trust @table/agent", "npm /@table%2fagent"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: @table/agent@2.0.0 (npm)", "→ Scan locally  ai-trust check @table/agent@2.0.0"],
        requests: ["trust @table/agent"],
      },
      "--json": {
        exit: 2,
        json: {"name": "@table/agent@2.0.0", "ecosystem": "npm", "found": false, "error": "Failed to download \"@table/agent@2.0.0\": Package \"@table/agent\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning @table/agent@2.0.0..."],
        requests: ["trust @table/agent", "npm /@table%2fagent"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "@table/agent@2.0.0", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check @table/agent@2.0.0", "npx hackmyagent secure <project-dir>"], "error": "Package \"@table/agent@2.0.0\" not found in the OpenA2A Registry."},
        requests: ["trust @table/agent"],
      },
    },
  },
  // The command --no-scan suggests for a version npm serves downloads and
  // scans that version.
  {
    form: "name@version the local npm registry serves",
    target: "table-scan-pkg@1.0.0",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["Scanning table-scan-pkg@1.0.0...", "table-scan-pkg@1.0.0  downloaded package"],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg@1.0.0 (npm)", "→ Scan locally  ai-trust check table-scan-pkg@1.0.0"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-scan-pkg@1.0.0", "ecosystem": "npm", "source": "scan", "found": true, "verdict": "safe"},
        shows: ["Scanning table-scan-pkg@1.0.0..."],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg@1.0.0", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg@1.0.0", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg@1.0.0\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  {
    form: "name@version the local npm registry does not have",
    target: "table-scan-pkg@9.9.9",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Scanning table-scan-pkg@9.9.9...", "Package not found: table-scan-pkg@9.9.9 (npm)"],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg@9.9.9 (npm)", "→ Scan locally  ai-trust check table-scan-pkg@9.9.9"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-scan-pkg@9.9.9", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-scan-pkg@9.9.9\": Version \"9.9.9\" of \"table-scan-pkg\" not found on npm. Verify the version and try again."},
        shows: ["Scanning table-scan-pkg@9.9.9..."],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg@9.9.9", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg@9.9.9", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg@9.9.9\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  // npm downloads the highest version a tag or a range names; the scan output
  // names that version beside the target as typed (#224).
  {
    form: "name@tag the local npm registry serves",
    target: "table-scan-pkg@latest",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["Scanning table-scan-pkg@latest...", "table-scan-pkg@latest (1.0.0)  downloaded package"],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg@latest (npm)", "→ Scan locally  ai-trust check table-scan-pkg@latest"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-scan-pkg@latest", "ecosystem": "npm", "version": "1.0.0", "source": "scan", "found": true, "verdict": "safe"},
        shows: ["Scanning table-scan-pkg@latest..."],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg@latest", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg@latest", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg@latest\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  {
    form: "name@range the local npm registry serves",
    target: "table-scan-pkg@1.x",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["Scanning table-scan-pkg@1.x...", "table-scan-pkg@1.x (1.0.0)  downloaded package"],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg@1.x (npm)", "→ Scan locally  ai-trust check table-scan-pkg@1.x"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-scan-pkg@1.x", "ecosystem": "npm", "version": "1.0.0", "source": "scan", "found": true, "verdict": "safe"},
        shows: ["Scanning table-scan-pkg@1.x..."],
        requests: ["trust table-scan-pkg", "npm /table-scan-pkg", "npm /table-scan-pkg/-/table-scan-pkg-1.0.0.tgz"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg@1.x", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg@1.x", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg@1.x\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  // The library list is consulted with the package name, so --no-scan gives a
  // versioned target the notice its package gets (#224).
  {
    form: "name@version, library by name with no registry data",
    target: "express@4.18.0",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Scanning express@4.18.0...", "Package not found: express@4.18.0 (npm)", "→ Scan locally  ai-trust check express@4.18.0"],
        requests: ["trust express", "npm /express"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["express  library (by name — no registry data)", "Out of scope for ai-trust — ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).", "npx hackmyagent check express"],
        requests: ["trust express"],
      },
      "--json": {
        exit: 2,
        json: {"name": "express@4.18.0", "ecosystem": "npm", "found": false, "error": "Failed to download \"express@4.18.0\": Package \"express\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning express@4.18.0..."],
        requests: ["trust express", "npm /express"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "express", "ecosystem": "npm", "found": false, "outOfScope": true, "nextSteps": ["npx hackmyagent check express"]},
        requests: ["trust express"],
      },
    },
  },
  // Text after the `@` that is not a version or tag is refused before npm
  // runs; npm would read `npm:<name>` as another package.
  {
    form: "name@ followed by an npm: alias",
    target: "table-scan-pkg@npm:table-tool",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Scanning table-scan-pkg@npm:table-tool...", "Error: Failed to download \"table-scan-pkg@npm:table-tool\": \"npm:table-tool\" is not a version or tag ai-trust can download. Give an exact version, as in table-scan-pkg@1.2.3, or a tag, as in table-scan-pkg@latest."],
        requests: ["trust table-scan-pkg"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-scan-pkg@npm:table-tool (npm)", "→ Scan locally  ai-trust check table-scan-pkg@npm:table-tool"],
        requests: ["trust table-scan-pkg"],
      },
      "--json": {
        exit: 1,
        json: {"name": "table-scan-pkg@npm:table-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-scan-pkg@npm:table-tool\": \"npm:table-tool\" is not a version or tag ai-trust can download. Give an exact version, as in table-scan-pkg@1.2.3, or a tag, as in table-scan-pkg@latest."},
        shows: ["Scanning table-scan-pkg@npm:table-tool..."],
        requests: ["trust table-scan-pkg"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-scan-pkg@npm:table-tool", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-scan-pkg@npm:table-tool", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-scan-pkg@npm:table-tool\" not found in the OpenA2A Registry."},
        requests: ["trust table-scan-pkg"],
      },
    },
  },
  {
    form: "npm:name",
    target: "npm:table-tool",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-tool (npm)", "→ Scan locally  ai-trust check table-tool", "Scanning table-tool..."],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["table-tool  mcp server", "No known issues", "→ Fresh scan  ai-trust check table-tool"],
        requests: ["trust table-tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-tool\": Package \"table-tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-tool..."],
        requests: ["trust table-tool", "npm /table-tool"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-tool", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        requests: ["trust table-tool"],
      },
    },
  },
  {
    form: "pip:name, registry library",
    target: "pip:table-pylib",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["table-pylib (pypi)  library (registry-classified)", "Out of scope for ai-trust — the registry classifies this as a general-purpose library.", "npx hackmyagent check pip:table-pylib"],
        requests: ["trust table-pylib"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["table-pylib (pypi)  library (registry-classified)", "Out of scope for ai-trust — the registry classifies this as a general-purpose library.", "npx hackmyagent check pip:table-pylib"],
        requests: ["trust table-pylib"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-pylib", "ecosystem": "pypi", "found": true, "outOfScope": true, "nextSteps": ["npx hackmyagent check pip:table-pylib"]},
        requests: ["trust table-pylib"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-pylib", "ecosystem": "pypi", "found": true, "outOfScope": true, "nextSteps": ["npx hackmyagent check pip:table-pylib"]},
        requests: ["trust table-pylib"],
      },
    },
  },
  // Kept as observed, though wrong: the not-found block and the --json
  // nextSteps suggest `ai-trust check table-py-agent`, without the pip:
  // prefix, a command that checks the npm package of that name.
  {
    form: "pip:name, no registry data",
    target: "pip:table-py-agent",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-py-agent (pypi)", "→ Scan locally  ai-trust check table-py-agent", "Scanning table-py-agent..."],
        requests: ["trust table-py-agent", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-py-agent (pypi)", "→ Scan locally  ai-trust check table-py-agent"],
        requests: ["trust table-py-agent"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-py-agent", "ecosystem": "pypi", "found": false, "error": "Failed to download \"table-py-agent\": Package \"table-py-agent\" not found on PyPI. Verify the package name and try again."},
        shows: ["Scanning table-py-agent..."],
        requests: ["trust table-py-agent", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-py-agent", "ecosystem": "pypi", "found": false, "nextSteps": ["ai-trust check table-py-agent", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-py-agent\" not found in the OpenA2A Registry."},
        requests: ["trust table-py-agent"],
      },
    },
  },
  // The registry is asked about a versioned pip: target by the package name;
  // PyPI is asked for that release, then for the project to tell a missing
  // release from a missing project (#224).
  {
    form: "pip:name@version, no registry data",
    target: "pip:table-py-agent@2.0.0",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Scanning table-py-agent@2.0.0...", "Package not found: table-py-agent@2.0.0 (pypi)"],
        requests: ["trust table-py-agent", "pypi /pypi/table-py-agent/2.0.0/json", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-py-agent@2.0.0 (pypi)"],
        requests: ["trust table-py-agent"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-py-agent@2.0.0", "ecosystem": "pypi", "found": false, "error": "Failed to download \"table-py-agent@2.0.0\": Package \"table-py-agent\" not found on PyPI. Verify the package name and try again."},
        shows: ["Scanning table-py-agent@2.0.0..."],
        requests: ["trust table-py-agent", "pypi /pypi/table-py-agent/2.0.0/json", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-py-agent@2.0.0", "ecosystem": "pypi", "found": false, "error": "Package \"table-py-agent@2.0.0\" not found in the OpenA2A Registry."},
        requests: ["trust table-py-agent"],
      },
    },
  },
  {
    form: "empty",
    target: "",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name given. Usage: ai-trust check <package>"],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name given. Usage: ai-trust check <package>"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name given. Usage: ai-trust check <package>"},
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name given. Usage: ai-trust check <package>"},
        requests: [],
      },
    },
  },
  {
    form: "pip: with nothing after",
    target: "pip:",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name after \"pip:\". Usage: ai-trust check pip:<package>"],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name after \"pip:\". Usage: ai-trust check pip:<package>"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name after \"pip:\". Usage: ai-trust check pip:<package>"},
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name after \"pip:\". Usage: ai-trust check pip:<package>"},
        requests: [],
      },
    },
  },
  {
    form: "npm: with nothing after",
    target: "npm:",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name after \"npm:\". Usage: ai-trust check npm:<package>"],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name after \"npm:\". Usage: ai-trust check npm:<package>"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name after \"npm:\". Usage: ai-trust check npm:<package>"},
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name after \"npm:\". Usage: ai-trust check npm:<package>"},
        requests: [],
      },
    },
  },
  // A bare skill: or mcp: is the same usage error as a bare pip: (#193).
  {
    form: "skill: with nothing after",
    target: "skill:",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name after \"skill:\". Usage: ai-trust check skill:<name>"],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name after \"skill:\". Usage: ai-trust check skill:<name>"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name after \"skill:\". Usage: ai-trust check skill:<name>"},
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name after \"skill:\". Usage: ai-trust check skill:<name>"},
        requests: [],
      },
    },
  },
  {
    form: "mcp: with nothing after",
    target: "mcp:",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name after \"mcp:\". Usage: ai-trust check mcp:<name>"],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name after \"mcp:\". Usage: ai-trust check mcp:<name>"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name after \"mcp:\". Usage: ai-trust check mcp:<name>"},
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name after \"mcp:\". Usage: ai-trust check mcp:<name>"},
        requests: [],
      },
    },
  },
  {
    form: "<owner>/<repo>",
    target: "table-owner/table-repo",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-owner/table-repo (npm)", "Looks like a git-style name. npm packages use \"@scope/name\" — did you mean \"@table-owner/table-repo\"?", "Did you mean?", "@table-owner/table-repo", "→ Scan locally  ai-trust check table-owner/table-repo", "Scanning table-owner/table-repo..."],
        requests: ["trust table-owner/table-repo"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-owner/table-repo (npm)", "→ Scan locally  ai-trust check table-owner/table-repo"],
        requests: ["trust table-owner/table-repo"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-owner/table-repo", "ecosystem": "npm", "found": false, "errorHint": "Looks like a git-style name. npm packages use \"@scope/name\" — did you mean \"@table-owner/table-repo\"?", "suggestions": ["@table-owner/table-repo"], "error": "Failed to download \"table-owner/table-repo\": \"table-owner/table-repo\" is not a valid npm package name."},
        shows: ["Scanning table-owner/table-repo..."],
        requests: ["trust table-owner/table-repo"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-owner/table-repo", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-owner/table-repo", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-owner/table-repo\" not found in the OpenA2A Registry."},
        requests: ["trust table-owner/table-repo"],
      },
    },
  },
  {
    form: "MCP shorthand server-*",
    target: "server-table",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: @modelcontextprotocol/server-table (npm)", "→ Scan locally  ai-trust check @modelcontextprotocol/server-table", "Resolved: server-table -> @modelcontextprotocol/server-table", "Scanning @modelcontextprotocol/server-table..."],
        requests: ["trust @modelcontextprotocol/server-table", "npm /@modelcontextprotocol%2fserver-table"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["@modelcontextprotocol/server-table  mcp server", "No known issues", "→ Fresh scan  ai-trust check @modelcontextprotocol/server-table", "Resolved: server-table -> @modelcontextprotocol/server-table"],
        requests: ["trust @modelcontextprotocol/server-table"],
      },
      "--json": {
        exit: 2,
        json: {"name": "@modelcontextprotocol/server-table", "ecosystem": "npm", "found": false, "error": "Failed to download \"@modelcontextprotocol/server-table\": Package \"@modelcontextprotocol/server-table\" not found on npm. Verify the package name and try again."},
        shows: ["Resolved: server-table -> @modelcontextprotocol/server-table", "Scanning @modelcontextprotocol/server-table..."],
        requests: ["trust @modelcontextprotocol/server-table", "npm /@modelcontextprotocol%2fserver-table"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "@modelcontextprotocol/server-table", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        shows: ["Resolved: server-table -> @modelcontextprotocol/server-table"],
        requests: ["trust @modelcontextprotocol/server-table"],
      },
    },
  },
  {
    form: "MCP shorthand mcp/server-*",
    target: "mcp/server-table",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: @modelcontextprotocol/server-table (npm)", "→ Scan locally  ai-trust check @modelcontextprotocol/server-table", "Resolved: mcp/server-table -> @modelcontextprotocol/server-table", "Scanning @modelcontextprotocol/server-table..."],
        requests: ["trust @modelcontextprotocol/server-table", "npm /@modelcontextprotocol%2fserver-table"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["@modelcontextprotocol/server-table  mcp server", "No known issues", "→ Fresh scan  ai-trust check @modelcontextprotocol/server-table", "Resolved: mcp/server-table -> @modelcontextprotocol/server-table"],
        requests: ["trust @modelcontextprotocol/server-table"],
      },
      "--json": {
        exit: 2,
        json: {"name": "@modelcontextprotocol/server-table", "ecosystem": "npm", "found": false, "error": "Failed to download \"@modelcontextprotocol/server-table\": Package \"@modelcontextprotocol/server-table\" not found on npm. Verify the package name and try again."},
        shows: ["Resolved: mcp/server-table -> @modelcontextprotocol/server-table", "Scanning @modelcontextprotocol/server-table..."],
        requests: ["trust @modelcontextprotocol/server-table", "npm /@modelcontextprotocol%2fserver-table"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "@modelcontextprotocol/server-table", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        shows: ["Resolved: mcp/server-table -> @modelcontextprotocol/server-table"],
        requests: ["trust @modelcontextprotocol/server-table"],
      },
    },
  },
  {
    form: "skill: with a registry narrative",
    target: "skill:table-skill",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["skill  ·  LISTED (UNSCANNED)"],
        requests: ["narrative skill:table-skill", "trust table-skill"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["skill  ·  LISTED (UNSCANNED)"],
        requests: ["narrative skill:table-skill", "trust table-skill"],
      },
      "--json": {
        exit: 0,
        json: {"name": "table-skill", "nextSteps": [], "artifactType": "skill"},
        requests: ["narrative skill:table-skill", "trust table-skill"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-skill", "nextSteps": [], "artifactType": "skill"},
        requests: ["narrative skill:table-skill", "trust table-skill"],
      },
    },
  },
  {
    form: "mcp: with no narrative",
    target: "mcp:table-tool",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-tool (npm)", "→ Scan locally  ai-trust check table-tool", "Scanning table-tool..."],
        requests: ["narrative mcp:table-tool", "trust table-tool", "npm /table-tool"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["table-tool  mcp server", "No known issues", "→ Fresh scan  ai-trust check table-tool"],
        requests: ["narrative mcp:table-tool", "trust table-tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-tool\": Package \"table-tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-tool..."],
        requests: ["narrative mcp:table-tool", "trust table-tool", "npm /table-tool"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "table-tool", "ecosystem": "npm", "source": "registry", "found": true, "verdict": "passed"},
        requests: ["narrative mcp:table-tool", "trust table-tool"],
      },
    },
  },
  // Same missing pip: prefix in the suggested command as the pip: row above.
  {
    form: "skill: naming a pip: target, no narrative",
    target: "skill:pip:table-py-agent",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-py-agent (pypi)", "→ Scan locally  ai-trust check table-py-agent", "Scanning table-py-agent..."],
        requests: ["narrative skill:pip:table-py-agent", "trust table-py-agent", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-py-agent (pypi)", "→ Scan locally  ai-trust check table-py-agent"],
        requests: ["narrative skill:pip:table-py-agent", "trust table-py-agent"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-py-agent", "ecosystem": "pypi", "found": false, "error": "Failed to download \"table-py-agent\": Package \"table-py-agent\" not found on PyPI. Verify the package name and try again."},
        shows: ["Scanning table-py-agent..."],
        requests: ["narrative skill:pip:table-py-agent", "trust table-py-agent", "pypi /pypi/table-py-agent/json"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-py-agent", "ecosystem": "pypi", "found": false, "nextSteps": ["ai-trust check table-py-agent", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-py-agent\" not found in the OpenA2A Registry."},
        requests: ["narrative skill:pip:table-py-agent", "trust table-py-agent"],
      },
    },
  },
  {
    form: "mcp: naming pip: with nothing after",
    target: "mcp:pip:",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Error: No package name after \"pip:\". Usage: ai-trust check pip:<package>"],
        requests: ["narrative mcp:pip:"],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: No package name after \"pip:\". Usage: ai-trust check pip:<package>"],
        requests: ["narrative mcp:pip:"],
      },
      "--json": {
        exit: 1,
        json: {"error": "No package name after \"pip:\". Usage: ai-trust check pip:<package>"},
        requests: ["narrative mcp:pip:"],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"error": "No package name after \"pip:\". Usage: ai-trust check pip:<package>"},
        requests: ["narrative mcp:pip:"],
      },
    },
  },
  {
    form: "all-zero package id",
    target: "table-zero-id",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-zero-id (npm)", "→ Scan locally  ai-trust check table-zero-id", "Scanning table-zero-id..."],
        requests: ["trust table-zero-id", "npm /table-zero-id"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: table-zero-id (npm)", "→ Scan locally  ai-trust check table-zero-id"],
        requests: ["trust table-zero-id"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-zero-id", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-zero-id\": Package \"table-zero-id\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning table-zero-id..."],
        requests: ["trust table-zero-id", "npm /table-zero-id"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "table-zero-id", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check table-zero-id", "npx hackmyagent secure <project-dir>"], "error": "Package \"table-zero-id\" not found in the OpenA2A Registry."},
        requests: ["trust table-zero-id"],
      },
    },
  },
  // Kept as observed, though wrong: without --no-scan, an all-zero package id
  // for a name on the library list is shown as "library (registry-classified)"
  // although the registry has no data; --no-scan treats the same answer as a
  // miss and says "by name — no registry data".
  {
    form: "all-zero package id for a library name",
    target: "chalk",
    cells: {
      "no flag": {
        exit: 0,
        shows: ["chalk  library (registry-classified)", "Out of scope for ai-trust — the registry classifies this as a general-purpose library.", "npx hackmyagent check chalk"],
        requests: ["trust chalk"],
      },
      "--no-scan": {
        exit: 0,
        shows: ["chalk  library (by name — no registry data)", "Out of scope for ai-trust — ai-trust is for AI packages (MCP servers, agents, skills, AI tools, LLMs).", "npx hackmyagent check chalk"],
        requests: ["trust chalk"],
      },
      "--json": {
        exit: 0,
        json: {"name": "chalk", "ecosystem": "npm", "found": false, "outOfScope": true, "nextSteps": ["npx hackmyagent check chalk"]},
        requests: ["trust chalk"],
      },
      "--no-scan --json": {
        exit: 0,
        json: {"name": "chalk", "ecosystem": "npm", "found": false, "outOfScope": true, "nextSteps": ["npx hackmyagent check chalk"]},
        requests: ["trust chalk"],
      },
    },
  },
  {
    form: "registry error",
    target: "table-registry-error",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: table-registry-error (npm)", "→ Scan locally  ai-trust check table-registry-error", "Registry lookup failed (Registry API returned 500); proceeding with local scan.", "Scanning table-registry-error..."],
        requests: ["trust table-registry-error", "npm /table-registry-error"],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: Registry API returned 500"],
        requests: ["trust table-registry-error"],
      },
      "--json": {
        exit: 2,
        json: {"name": "table-registry-error", "ecosystem": "npm", "found": false, "error": "Failed to download \"table-registry-error\": Package \"table-registry-error\" not found on npm. Verify the package name and try again."},
        shows: ["Registry lookup failed (Registry API returned 500); proceeding with local scan.", "Scanning table-registry-error..."],
        requests: ["trust table-registry-error", "npm /table-registry-error"],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"name": "table-registry-error", "ecosystem": "npm", "found": false, "error": "Registry API returned 500"},
        requests: ["trust table-registry-error"],
      },
    },
  },
  // Kept as observed, though wrong: the "Scanning ..." line and the download
  // error print the target's escape sequence as it was typed.
  {
    form: "control characters",
    target: "\u001b[31mtable-tool",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Registry lookup failed (RegistryClient: package name contains control characters); proceeding with local scan.", "Scanning \u001b[31mtable-tool...", "Error: Failed to download \"\u001b[31mtable-tool\": \"\u001b[31mtable-tool\" is not a valid npm package name."],
        requests: [],
      },
      "--no-scan": {
        exit: 1,
        shows: ["Error: RegistryClient: package name contains control characters"],
        requests: [],
      },
      "--json": {
        exit: 1,
        json: {"name": "\u001b[31mtable-tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"\u001b[31mtable-tool\": \"\u001b[31mtable-tool\" is not a valid npm package name."},
        shows: ["Registry lookup failed (RegistryClient: package name contains control characters); proceeding with local scan.", "Scanning \u001b[31mtable-tool..."],
        requests: [],
      },
      "--no-scan --json": {
        exit: 1,
        json: {"name": "\u001b[31mtable-tool", "ecosystem": "npm", "found": false, "error": "RegistryClient: package name contains control characters"},
        requests: [],
      },
    },
  },
  {
    form: "upper case",
    target: "Table-Tool",
    cells: {
      "no flag": {
        exit: 2,
        shows: ["Package not found: Table-Tool (npm)", "→ Scan locally  ai-trust check Table-Tool", "Scanning Table-Tool..."],
        requests: ["trust Table-Tool", "npm /Table-Tool"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: Table-Tool (npm)", "→ Scan locally  ai-trust check Table-Tool"],
        requests: ["trust Table-Tool"],
      },
      "--json": {
        exit: 2,
        json: {"name": "Table-Tool", "ecosystem": "npm", "found": false, "error": "Failed to download \"Table-Tool\": Package \"Table-Tool\" not found on npm. Verify the package name and try again."},
        shows: ["Scanning Table-Tool..."],
        requests: ["trust Table-Tool", "npm /Table-Tool"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "Table-Tool", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check Table-Tool", "npx hackmyagent secure <project-dir>"], "error": "Package \"Table-Tool\" not found in the OpenA2A Registry."},
        requests: ["trust Table-Tool"],
      },
    },
  },
  {
    form: "URL",
    target: "https://github.com/table-owner/table-repo",
    cells: {
      "no flag": {
        exit: 1,
        shows: ["Scanning https://github.com/table-owner/table-repo...", "Error: Failed to download \"https://github.com/table-owner/table-repo\": \"https://github.com/table-owner/table-repo\" is not a valid npm package name."],
        requests: ["trust https://github.com/table-owner/table-repo"],
      },
      "--no-scan": {
        exit: 2,
        shows: ["Package not found: https://github.com/table-owner/table-repo (npm)", "→ Scan locally  ai-trust check https://github.com/table-owner/table-repo"],
        requests: ["trust https://github.com/table-owner/table-repo"],
      },
      "--json": {
        exit: 1,
        json: {"name": "https://github.com/table-owner/table-repo", "ecosystem": "npm", "found": false, "error": "Failed to download \"https://github.com/table-owner/table-repo\": \"https://github.com/table-owner/table-repo\" is not a valid npm package name."},
        shows: ["Scanning https://github.com/table-owner/table-repo..."],
        requests: ["trust https://github.com/table-owner/table-repo"],
      },
      "--no-scan --json": {
        exit: 2,
        json: {"name": "https://github.com/table-owner/table-repo", "ecosystem": "npm", "found": false, "nextSteps": ["ai-trust check https://github.com/table-owner/table-repo", "npx hackmyagent secure <project-dir>"], "error": "Package \"https://github.com/table-owner/table-repo\" not found in the OpenA2A Registry."},
        requests: ["trust https://github.com/table-owner/table-repo"],
      },
    },
  },
];

let scratch: string;
let tarballName: string;
let tarball: Buffer;
const observed = new Map<string, Observed>();

function cellKey(target: string, mode: Mode): string {
  return `${JSON.stringify(target)} ${mode}`;
}

function startServer(requests: string[]): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    if (url.pathname === "/api/v1/trust/query") {
      const name = url.searchParams.get("name") ?? "";
      requests.push(`trust ${name}`);
      const answer = TRUST[name];
      return answer ? send(answer.status, answer.body) : send(404, { error: "package not found" });
    }
    if (url.pathname === "/api/v1/trust/narrative") {
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      requests.push(`narrative ${type}:${name}`);
      return type === "skill" && name === "table-skill"
        ? send(200, SKILL_NARRATIVE)
        : send(404, { error: "no narrative" });
    }
    if (url.pathname.startsWith("/pypi/")) {
      requests.push(`pypi ${url.pathname}`);
      return send(404, { message: "Not Found" });
    }
    if (req.method !== "GET") {
      requests.push(`${req.method} ${url.pathname}`);
      return send(200, {});
    }
    // Anything else is npm asking for a packument or a tarball. npm can ask
    // twice in a row for the same path; that counts as one request.
    if (requests[requests.length - 1] !== `npm ${url.pathname}`) requests.push(`npm ${url.pathname}`);
    if (url.pathname === `/${SCAN_PACKAGE}`) {
      return send(200, {
        name: SCAN_PACKAGE,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: SCAN_PACKAGE,
            version: "1.0.0",
            dist: {
              tarball: `${base}/${SCAN_PACKAGE}/-/${tarballName}`,
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            },
          },
        },
      });
    }
    if (url.pathname === `/${SCAN_PACKAGE}/-/${tarballName}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(tarball);
    }
    return send(404, { error: "Not found" });
  });
  return new Promise((ready) => srv.listen(0, "127.0.0.1", () => ready(srv)));
}

/** No host config, no consent file, no telemetry, and no network. */
function isolatedEnv(cellDir: string, baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(cellDir, "home"),
    XDG_CONFIG_HOME: join(cellDir, "home"),
    NO_COLOR: "1",
    CI: "true",
    OPENA2A_TELEMETRY: "off",
    NODE_OPTIONS: `--import=${pathToFileURL(join(scratch, "fetch-guard.mjs")).href}`,
    TABLE_PYPI_URL: baseUrl,
    npm_config_registry: `${baseUrl}/`,
    npm_config_cache: join(cellDir, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

async function runCell(target: string, mode: Mode, index: number): Promise<Observed> {
  const cellDir = join(scratch, `cell-${index}`);
  mkdirSync(join(cellDir, "home"), { recursive: true });
  const requests: string[] = [];
  const server = await startServer(requests);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await new Promise<Observed>((done, fail) => {
      const child = spawn(
        process.execPath,
        [CLI_PATH, "check", target, ...MODES[mode], "--registry-url", baseUrl],
        { cwd: cellDir, env: isolatedEnv(cellDir, baseUrl), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr, requests }));
    });
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
}

beforeAll(async () => {
  if (!existsSync(CLI_PATH)) return;
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-target-table-"));
  writeFileSync(
    join(scratch, "fetch-guard.mjs"),
    [
      "const realFetch = globalThis.fetch;",
      "globalThis.fetch = (input, init) => {",
      "  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);",
      "  if (url.origin === 'https://pypi.org') {",
      "    return realFetch(process.env.TABLE_PYPI_URL + url.pathname + url.search, init);",
      "  }",
      "  if (url.hostname !== '127.0.0.1') {",
      "    return Promise.reject(new TypeError(`offline test: no request to ${url.origin}`));",
      "  }",
      "  return realFetch(input, init);",
      "};",
      "",
    ].join("\n"),
  );

  // The one package the local npm registry serves, packed from two files.
  const source = join(scratch, "source");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: SCAN_PACKAGE, version: "1.0.0" }));
  writeFileSync(join(source, "index.js"), "module.exports = 1;\n");
  execFileSync("npm", ["pack", "--pack-destination", scratch], { cwd: source, stdio: "pipe" });
  tarballName = readdirSync(scratch).find((f) => f.endsWith(".tgz")) ?? "";
  tarball = readFileSync(join(scratch, tarballName));

  const jobs: Array<{ target: string; mode: Mode }> = [];
  for (const row of ROWS) {
    for (const mode of Object.keys(MODES) as Mode[]) jobs.push({ target: row.target, mode });
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const { target, mode } = jobs[index];
      observed.set(cellKey(target, mode), await runCell(target, mode, index));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}, 600_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("check reads each target form the same way at every step", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  for (const row of ROWS) {
    for (const mode of Object.keys(MODES) as Mode[]) {
      const cell = row.cells[mode];
      it(`${row.form}: check ${JSON.stringify(row.target)} ${mode}`, () => {
        const run = observed.get(cellKey(row.target, mode));
        expect(run).toBeDefined();
        if (!run) return;
        const output = run.stdout + run.stderr;
        expect(run.status).toBe(cell.exit);
        for (const text of cell.shows ?? []) expect(output).toContain(text);
        if (cell.json) expect(JSON.parse(run.stdout)).toMatchObject(cell.json);
        expect(run.requests).toEqual(cell.requests);
      });
    }
  }
});
