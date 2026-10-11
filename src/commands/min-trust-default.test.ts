/**
 * The README states the `--min-trust` default that CI users gate on. It said
 * "default 3" while `audit` and `batch` default to 2, so a reader expected an
 * unscanned (Listed, level 2) package to fail the gate when it exits 0.
 *
 * Reads the default from the registered Commander options, so a change to
 * either the code or the README that splits them fails here.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerAuditCommand } from "./audit.js";
import { registerBatchCommand } from "./batch.js";

const README_PATH = resolve(__dirname, "../../README.md");

function minTrustDefault(commandName: string): unknown {
  const program = new Command();
  registerAuditCommand(program);
  registerBatchCommand(program);
  const command = program.commands.find((c) => c.name() === commandName);
  return command?.options.find((o) => o.long === "--min-trust")?.defaultValue;
}

/** Every default the README states on a line that mentions `--min-trust`. */
function readmeMinTrustDefaults(): string[] {
  return readFileSync(README_PATH, "utf8")
    .split("\n")
    .filter((line) => line.includes("--min-trust"))
    .flatMap((line) => [...line.matchAll(/defaults? (?:to )?(\d)/g)].map((m) => m[1]));
}

describe("--min-trust default", () => {
  it("is the same for audit and batch", () => {
    expect(minTrustDefault("audit")).toBe("2");
    expect(minTrustDefault("batch")).toBe(minTrustDefault("audit"));
  });

  it("is stated in the README", () => {
    expect(readmeMinTrustDefaults().length).toBeGreaterThan(0);
  });

  it("matches every default the README states", () => {
    for (const stated of readmeMinTrustDefaults()) {
      expect(stated).toBe(minTrustDefault("audit"));
    }
  });
});
