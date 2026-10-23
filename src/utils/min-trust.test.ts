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

  // JSON.stringify escapes U+0000 to U+001F but not DEL or the C1 controls,
  // so the refusal wrote them, the one-character CSI U+009B among them, as
  // they were (#289).
  it("writes DEL in a refused value as \\u007f", () => {
    expect(parseMinTrust("\u007f9")).toEqual({ problem: `${REFUSAL} "\\u007f9"` });
    expect(parseMinTrust("9\u007f")).toEqual({ problem: `${REFUSAL} "9\\u007f"` });
  });

  it("writes each C1 control in a refused value, U+0080 to U+009F, as its \\u escape", () => {
    expect(parseMinTrust("\u009b31m9")).toEqual({ problem: `${REFUSAL} "\\u009b31m9"` });
    for (let code = 0x80; code <= 0x9f; code++) {
      const char = String.fromCharCode(code);
      const escape = `\\u00${code.toString(16)}`;
      const result = parseMinTrust(`${char}9`);
      expect(result, escape).toEqual({ problem: `${REFUSAL} "${escape}9"` });
      expect("problem" in result && /[\u007f-\u009f]/.test(result.problem), escape).toBe(false);
    }
    expect(parseMinTrust(" 9")).toEqual({ problem: `${REFUSAL} " 9"` });
  });

  // JSON.stringify also leaves U+2028, U+2029 and the format characters
  // (category Cf) as they are, so the refusal wrote them, U+200B ZERO WIDTH
  // SPACE and U+202E RIGHT-TO-LEFT OVERRIDE among them, as they were (#292).
  it("writes U+2028, U+2029 and the format characters in a refused value as \\u escapes", () => {
    expect(parseMinTrust("2\u{200b}")).toEqual({ problem: `${REFUSAL} "2\\u200b"` });
    expect(parseMinTrust("\u{202e}9")).toEqual({ problem: `${REFUSAL} "\\u202e9"` });
    expect(parseMinTrust("2\u{2028}3")).toEqual({ problem: `${REFUSAL} "2\\u20283"` });
    expect(parseMinTrust("2\u{2029}3")).toEqual({ problem: `${REFUSAL} "2\\u20293"` });
    expect(parseMinTrust("\u{feff}9")).toEqual({ problem: `${REFUSAL} "\\ufeff9"` });
    // Above U+FFFF, the escapes of the UTF-16 surrogate pair.
    expect(parseMinTrust("2\u{e0041}")).toEqual({ problem: `${REFUSAL} "2\\udb40\\udc41"` });
  });

  // The characters hasDisplayHazard names: the C0 and C1 controls, DEL,
  // U+2028, U+2029 and the format characters.
  it("writes each control, separator and format character as escapes that read back as the value", () => {
    const hazard = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\p{Cf}]/u;
    const chars: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (hazard.test(char)) chars.push(char);
    }
    expect(chars).toContain("\u{200b}");
    expect(chars).toContain("\u{2029}");
    expect(chars).toContain("\u{e007f}");
    for (const char of chars) {
      const value = `${char}9`;
      const label = `U+${char.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      const result = parseMinTrust(value);
      expect("problem" in result, label).toBe(true);
      if (!("problem" in result)) continue;
      expect(result.problem.startsWith(`${REFUSAL} "`), label).toBe(true);
      expect(hazard.test(result.problem), label).toBe(false);
      expect(JSON.parse(result.problem.slice(REFUSAL.length + 1)), label).toBe(value);
    }
  });
});
