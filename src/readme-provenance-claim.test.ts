/**
 * The provenance claim in the install docs must match what the npm registry
 * holds.
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
 * The claim lives in docs/install.md ("Verifying what was installed"), which
 * the README links from its Install section; the README itself is checked too,
 * so a claim added back there is held to the same wording.
 *
 * The test reads no network: it pins the wording to that boundary so an
 * unscoped "every release" claim cannot come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "docs/install.md"];

const FIRST_ATTESTED = "0.3.0";
const LAST_UNATTESTED = "0.2.25";

/** The paragraphs of a document that mention SLSA provenance. */
function provenanceParagraphs(doc: string): string[] {
  return readFileSync(resolve(ROOT, doc), "utf8")
    .split(/\n\s*\n/)
    .filter((p) => /SLSA/.test(p));
}

describe("provenance claim", () => {
  it("docs/install.md has a provenance paragraph to check", () => {
    expect(provenanceParagraphs("docs/install.md").length).toBeGreaterThan(0);
  });

  it.each(DOCS)("%s scopes the claim to the first attested release", (doc) => {
    for (const p of provenanceParagraphs(doc)) {
      expect(p).not.toMatch(/\bevery release publishes\b/i);
      expect(p).toContain(FIRST_ATTESTED);
    }
  });

  it.each(DOCS)("%s names the releases that carry no attestation", (doc) => {
    const paragraphs = provenanceParagraphs(doc);
    if (paragraphs.length === 0) return;
    expect(paragraphs.join("\n")).toContain(LAST_UNATTESTED);
  });
});
