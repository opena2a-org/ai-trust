/**
 * Tests for the score ai-trust computes from a scan's failed findings.
 */

import { describe, it, expect } from "vitest";
import { decayScore, scoreForWeightedSum } from "./decay-score.js";

describe("scoreForWeightedSum", () => {
  it("gives 100 for a weighted sum of 0 and round(100 * exp(-sum / 150)) for any other", () => {
    expect(scoreForWeightedSum(0)).toBe(100);
    // One high finding.
    expect(scoreForWeightedSum(15)).toBe(90);
    // Two medium findings and one low.
    expect(scoreForWeightedSum(19)).toBe(88);
    // 25 medium findings and one low.
    expect(scoreForWeightedSum(203)).toBe(26);
  });
});

describe("decayScore", () => {
  const finding = (severity: string, passed = false) => ({ severity, passed });

  it("weighs a failed critical finding 25, high 15, medium 8, low 3 and any other severity 8", () => {
    expect(decayScore([finding("critical")])).toBe(85);
    expect(decayScore([finding("high")])).toBe(90);
    expect(decayScore([finding("medium")])).toBe(95);
    expect(decayScore([finding("low")])).toBe(98);
    expect(decayScore([finding("info")])).toBe(95);
    // 25 + 8 = 33.
    expect(decayScore([finding("critical"), finding("medium")])).toBe(80);
  });

  it("does not count passed findings", () => {
    expect(decayScore([])).toBe(100);
    expect(decayScore([finding("critical", true), finding("high", true)])).toBe(100);
    expect(decayScore([finding("high"), finding("critical", true), finding("medium", true)])).toBe(90);
  });
});
