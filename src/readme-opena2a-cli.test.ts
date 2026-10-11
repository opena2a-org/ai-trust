/**
 * The README's "Using with opena2a-cli" section must name the opena2a-cli
 * command that actually runs ai-trust (issue #109).
 *
 * opena2a-cli exposes `ai-trust check <pkg>` as `opena2a registry <pkg>` and
 * sets `AI_TRUST_CLI_PREFIX=opena2a registry` when it runs us (see
 * `src/utils/cli-prefix.ts`). `opena2a trust` is a different opena2a-cli
 * command (a read-only registry trust-profile lookup) that does not run
 * ai-trust, so a README pointing users there sends them to a different report.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(resolve(HERE, "..", "README.md"), "utf8");

function section(heading: string): string {
  const start = README.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`README has no "## ${heading}" section`);
  const end = README.indexOf("\n## ", start + 1);
  return README.slice(start, end === -1 ? undefined : end);
}

describe("README: Using with opena2a-cli", () => {
  const text = section("Using with opena2a-cli");

  it("names `opena2a registry` as the command ai-trust powers", () => {
    expect(text).toContain("ai-trust powers `opena2a registry`");
  });

  it("shows the package lookup example as `opena2a registry <pkg>`", () => {
    expect(text).toMatch(/^opena2a registry \S+/m);
    expect(text).not.toMatch(/^opena2a trust\b/m);
  });
});
