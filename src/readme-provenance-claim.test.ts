/**
 * README.md's provenance claim must match what the npm registry holds.
 *
 * Releases 0.1.0 through 0.2.25 were published without an attestation;
 * 0.3.0 is the first version whose `dist.attestations.provenance.predicateType`
 * is `https://slsa.dev/provenance/v1`, and every version after it carries one.
 * A published version cannot gain an attestation later, so this boundary is
 * fixed. Re-check it with:
 *
 *   npm view ai-trust@0.2.25 dist.attestations.provenance.predicateType   # empty
 *   npm view ai-trust@0.3.0  dist.attestations.provenance.predicateType   # slsa v1
 *
 * The test reads no network: it pins the README wording to that boundary so
 * an unscoped "every release" claim cannot come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(resolve(HERE, "..", "README.md"), "utf8");

const FIRST_ATTESTED = "0.3.0";
const LAST_UNATTESTED = "0.2.25";

/** The paragraphs of README.md that mention SLSA provenance. */
function provenanceParagraphs(): string[] {
  return README.split(/\n\s*\n/).filter((p) => /SLSA/.test(p));
}

describe("README provenance claim", () => {
  it("has a provenance paragraph to check", () => {
    expect(provenanceParagraphs().length).toBeGreaterThan(0);
  });

  it("scopes the claim to the first attested release", () => {
    for (const p of provenanceParagraphs()) {
      expect(p).not.toMatch(/\bevery release publishes\b/i);
      expect(p).toContain(FIRST_ATTESTED);
    }
  });

  it("names the releases that carry no attestation", () => {
    const text = provenanceParagraphs().join("\n");
    expect(text).toContain(LAST_UNATTESTED);
  });
});
