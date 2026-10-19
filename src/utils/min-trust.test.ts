import { describe, it, expect } from "vitest";
import { MIN_TRUST_RANGE_PROBLEM, parseMinTrust } from "./min-trust.js";

describe("parseMinTrust", () => {
  it("reads each whole number from 0 to 4 as that level", () => {
    for (const level of [0, 1, 2, 3, 4]) {
      expect(parseMinTrust(String(level))).toEqual({ level });
    }
    expect(parseMinTrust(" 3 ")).toEqual({ level: 3 });
  });

  it("refuses a number that is not whole instead of cutting it to one", () => {
    expect(parseMinTrust("2.5")).toEqual({
      problem: "--min-trust must be a whole number between 0 and 4, not 2.5",
    });
    expect(parseMinTrust("3.0")).toEqual({
      problem: "--min-trust must be a whole number between 0 and 4, not 3.0",
    });
    expect(parseMinTrust("1e0")).toEqual({
      problem: "--min-trust must be a whole number between 0 and 4, not 1e0",
    });
  });

  it("refuses a whole number outside 0-4 and text that is not a number", () => {
    for (const value of ["5", "-1", "9", "abc", "2abc", ""]) {
      expect(parseMinTrust(value), value).toEqual({ problem: MIN_TRUST_RANGE_PROBLEM });
    }
  });
});
