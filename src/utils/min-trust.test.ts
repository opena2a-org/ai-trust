import { describe, it, expect } from "vitest";
import { parseMinTrust } from "./min-trust.js";

const REFUSAL = "--min-trust must be a whole number between 0 and 4, not";

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

  // A whole number outside 0-4 and text that is not a number were refused as
  // "--min-trust must be a number between 0 and 4", without the value (#276).
  it("refuses a whole number outside 0-4 and text that is not a number in the same words, naming the value", () => {
    for (const value of ["5", "-1", "9", "abc", "2abc"]) {
      expect(parseMinTrust(value), value).toEqual({ problem: `${REFUSAL} ${value}` });
    }
  });

  it("names an empty value, or one with a space or a control character in it, as a JSON string", () => {
    expect(parseMinTrust("")).toEqual({ problem: `${REFUSAL} ""` });
    expect(parseMinTrust("   ")).toEqual({ problem: `${REFUSAL} "   "` });
    expect(parseMinTrust("2 3")).toEqual({ problem: `${REFUSAL} "2 3"` });
    expect(parseMinTrust("\u001b[31m3")).toEqual({ problem: `${REFUSAL} "\\u001b[31m3"` });
    expect(parseMinTrust("2\n3")).toEqual({ problem: `${REFUSAL} "2\\n3"` });
  });

  // The refusal named the value with the whitespace around it dropped: " 9"
  // as 9, "\t5" as 5 and "   " as "" (#282).
  it("names a value with whitespace before or after it as given, the whitespace included", () => {
    expect(parseMinTrust(" 9")).toEqual({ problem: `${REFUSAL} " 9"` });
    expect(parseMinTrust("9 ")).toEqual({ problem: `${REFUSAL} "9 "` });
    expect(parseMinTrust("\t5")).toEqual({ problem: `${REFUSAL} "\\t5"` });
    expect(parseMinTrust("5\n")).toEqual({ problem: `${REFUSAL} "5\\n"` });
    expect(parseMinTrust(" 2.5 ")).toEqual({ problem: `${REFUSAL} " 2.5 "` });
  });
});
