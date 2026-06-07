/**
 * Integration test for ai-trust's first-party publish-signing contract.
 *
 * ai-trust's audit (--scan-missing bulk) and check publish paths build a signer with
 * `firstPartySignerFromEnv({ keyEnv: "AI_TRUST_CI_SIGNING_KEY", source: "ci" })` and pass
 * it to the shared client's `publishScan`. This locks down the three regression vectors a
 * future refactor could silently break — none of which the mocked audit/check tests catch,
 * because they stub the whole registry-client module:
 *
 *   1. The env var name is exactly AI_TRUST_CI_SIGNING_KEY.
 *   2. The claimed source is exactly "ci" (NOT first_party_scanner — ai-trust is our CI).
 *   3. ai-trust never sends `version`, so the signed STRONG canonical has an EMPTY version
 *      segment (`name||score|maxScore|ci|nonce|signedAt`). The signature must still verify
 *      against the raw 32-byte public key, or every ci-signed publish silently downgrades
 *      to community at the registry.
 *
 * Uses the real @opena2a/registry-client signer (this file deliberately does NOT mock it).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import { firstPartySignerFromEnv, strongCanonical } from "@opena2a/registry-client";

const KEY_ENV = "AI_TRUST_CI_SIGNING_KEY";

// A fixed 32-byte seed (base64), the way our CI secret store would supply it.
const SEED = Buffer.alloc(32, 7);

// ai-trust's actual submission shape is version-less (audit.ts / check.ts never set version).
const SCAN = { name: "@scope/pkg", score: 90, maxScore: 100 } as const;

describe("ai-trust first-party (source=ci) signing", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY_ENV];
    delete process.env[KEY_ENV];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY_ENV];
    } else {
      process.env[KEY_ENV] = original;
    }
  });

  it("returns no signer when AI_TRUST_CI_SIGNING_KEY is unset (publishes as community)", () => {
    const signer = firstPartySignerFromEnv({ keyEnv: KEY_ENV, source: "ci" });
    expect(signer).toBeUndefined();
  });

  it("signs source=ci with a signature that verifies over the version-less strong canonical", () => {
    process.env[KEY_ENV] = SEED.toString("base64");

    const signer = firstPartySignerFromEnv({ keyEnv: KEY_ENV, source: "ci" });
    expect(signer).toBeDefined();

    const prov = signer!.sign(SCAN);

    // Provenance class is "ci", not first_party_scanner.
    expect(prov.source).toBe("ci");
    expect(typeof prov.nonce).toBe("string");
    expect(prov.nonce.length).toBeGreaterThan(0);
    expect(String(prov.signedAt).length).toBe(10); // Unix SECONDS, not ms.

    // Raw 32-byte Ed25519 public key (base64), not a PEM block.
    expect(prov.publicKey).not.toContain("BEGIN");
    expect(Buffer.from(prov.publicKey, "base64").length).toBe(32);

    // The canonical ai-trust signs has an EMPTY version segment: name||score|maxScore|...
    const canonical = strongCanonical(SCAN, prov.source, prov.nonce, prov.signedAt);
    expect(canonical).toBe(`${SCAN.name}||${SCAN.score}|${SCAN.maxScore}|ci|${prov.nonce}|${prov.signedAt}`);

    // The signature verifies against the on-wire public key — proving the registry would
    // honor source=ci instead of downgrading to community.
    const ok = nacl.sign.detached.verify(
      Buffer.from(canonical, "utf-8"),
      Buffer.from(prov.signature, "base64"),
      Buffer.from(prov.publicKey, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("mints a fresh nonce per sign() call (bulk --scan-missing must not reuse nonces)", () => {
    process.env[KEY_ENV] = SEED.toString("base64");
    const signer = firstPartySignerFromEnv({ keyEnv: KEY_ENV, source: "ci" })!;

    const a = signer.sign(SCAN);
    const b = signer.sign(SCAN);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
