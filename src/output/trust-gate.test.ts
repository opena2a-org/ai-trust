/**
 * Tests for the trust gate that sets the exit code of audit and batch.
 */

import { describe, it, expect } from "vitest";
import type { TrustAnswer } from "@opena2a/registry-client";
import type { BatchAnswer } from "./formatter.js";
import { trustGate } from "./trust-gate.js";

function answer(overrides: Partial<TrustAnswer> = {}): TrustAnswer {
  return {
    name: "my-mcp",
    trustLevel: 3,
    trustScore: 0.85,
    verdict: "safe",
    found: true,
    packageType: "mcp_server",
    scanStatus: "complete",
    ...overrides,
  };
}

describe("trustGate", () => {
  it("passes when every dependency is found at or above the minimum trust level", () => {
    const gate = trustGate(
      [answer(), answer({ name: "left-pad", packageType: "library", trustLevel: 2, verdict: "listed" })],
      2
    );

    expect(gate).toEqual({ passed: true, notFound: [], belowThreshold: [], excludedByType: [] });
  });

  it("fails on a dependency the registry does not have, whatever its tier", () => {
    const gate = trustGate(
      [
        answer(),
        answer({ name: "missing-mcp", found: false }),
        answer({ name: "@types/missing", found: false, packageType: undefined }),
        answer({ name: "novel-random-pkg", found: false, packageType: undefined }),
      ],
      2
    );

    expect(gate.passed).toBe(false);
    expect(gate.notFound.map((r) => r.name)).toEqual([
      "missing-mcp",
      "@types/missing",
      "novel-random-pkg",
    ]);
    expect(gate.belowThreshold).toEqual([]);
  });

  it("fails on a library below the minimum trust level, as check exits 2 for a blocked library", () => {
    const gate = trustGate(
      [answer(), answer({ name: "bad-lib", packageType: "library", trustLevel: 0, verdict: "blocked" })],
      2
    );

    expect(gate.passed).toBe(false);
    expect(gate.belowThreshold.map((r) => r.name)).toEqual(["bad-lib"]);
  });

  it("does not count a not-found answer as below the level", () => {
    const gate = trustGate([answer({ name: "missing-mcp", found: false, trustLevel: 0 })], 2);

    expect(gate.notFound.map((r) => r.name)).toEqual(["missing-mcp"]);
    expect(gate.belowThreshold).toEqual([]);
  });

  it("fails on a package batch --type excluded, and counts it neither as not found nor below the level", () => {
    const excluded: BatchAnswer = { ...answer({ name: "registered-mcp", trustLevel: 1 }), excludedByType: true };
    const gate = trustGate([answer({ name: "some-agent", packageType: "a2a_agent" }), excluded], 2);

    expect(gate.passed).toBe(false);
    expect(gate.excludedByType.map((r) => r.name)).toEqual(["registered-mcp"]);
    expect(gate.notFound).toEqual([]);
    expect(gate.belowThreshold).toEqual([]);
  });

  it("returns the names without control characters, as the text prints them", () => {
    const gate = trustGate([answer({ name: "gone\u001b]0;x\u0007\r\nSECOND", found: false })], 2);

    expect(gate.notFound.map((r) => r.name)).toEqual(["gone]0;x SECOND"]);
  });
});
