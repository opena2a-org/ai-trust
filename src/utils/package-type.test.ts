import { describe, it, expect } from "vitest";
import { packageTypeProblem } from "./package-type.js";

const REFUSAL = "--type must be one of mcp_server, a2a_agent, skill, ai_tool, llm, library; got";

describe("packageTypeProblem", () => {
  it("takes no value and each package type", () => {
    expect(packageTypeProblem(undefined)).toBeUndefined();
    for (const type of ["mcp_server", "a2a_agent", "skill", "ai_tool", "llm", "library"]) {
      expect(packageTypeProblem(type), type).toBeUndefined();
    }
  });

  it("names a refused value as a JSON string", () => {
    expect(packageTypeProblem("banana")).toBe(`${REFUSAL} "banana"`);
    expect(packageTypeProblem("")).toBe(`${REFUSAL} ""`);
    expect(packageTypeProblem("mcp server")).toBe(`${REFUSAL} "mcp server"`);
    expect(packageTypeProblem("mcp\tserver")).toBe(`${REFUSAL} "mcp\\tserver"`);
    expect(packageTypeProblem("\u001b[31mmcp")).toBe(`${REFUSAL} "\\u001b[31mmcp"`);
  });

  // JSON.stringify leaves DEL, the C1 controls, U+2028, U+2029 and the format
  // characters as they are, so the refusal wrote them, the one-character CSI
  // U+009B and U+202E RIGHT-TO-LEFT OVERRIDE among them, as they were (#295).
  it("writes DEL, the C1 controls, U+2028, U+2029 and the format characters in a refused value as \\u escapes", () => {
    expect(packageTypeProblem("mcp\u{202e}")).toBe(`${REFUSAL} "mcp\\u202e"`);
    expect(packageTypeProblem("mcp\u{9b}31m")).toBe(`${REFUSAL} "mcp\\u009b31m"`);
    expect(packageTypeProblem("mcp\u{200b}")).toBe(`${REFUSAL} "mcp\\u200b"`);
    expect(packageTypeProblem("mcp\u{7f}")).toBe(`${REFUSAL} "mcp\\u007f"`);
    expect(packageTypeProblem("mcp\u{2028}")).toBe(`${REFUSAL} "mcp\\u2028"`);
    expect(packageTypeProblem("mcp\u{2029}")).toBe(`${REFUSAL} "mcp\\u2029"`);
    // Above U+FFFF, the escapes of the UTF-16 surrogate pair.
    expect(packageTypeProblem("mcp\u{e0041}")).toBe(`${REFUSAL} "mcp\\udb40\\udc41"`);
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
    expect(chars).toContain("\u{9b}");
    expect(chars).toContain("\u{202e}");
    expect(chars).toContain("\u{e007f}");
    for (const char of chars) {
      const value = `mcp${char}`;
      const label = `U+${char.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      const problem = packageTypeProblem(value);
      expect(problem?.startsWith(`${REFUSAL} "`), label).toBe(true);
      if (problem === undefined) continue;
      expect(hazard.test(problem), label).toBe(false);
      expect(JSON.parse(problem.slice(REFUSAL.length + 1)), label).toBe(value);
    }
  });
});
