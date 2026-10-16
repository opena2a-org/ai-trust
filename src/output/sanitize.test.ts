/**
 * Registry strings are made terminal-safe before the text formatters print
 * them (#129).
 */
import { describe, it, expect } from "vitest";
import { capLength, sanitizeRegistryValue, stripControlCharacters } from "./sanitize.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("stripControlCharacters", () => {
  it("removes ESC and BEL from an OSC title sequence", () => {
    const cleaned = stripControlCharacters("CVE-\u001b]0;x\u0007-1");
    expect(cleaned).toBe("CVE-]0;x-1");
    expect(cleaned).not.toMatch(CONTROL);
  });

  it("removes the ESC of a CSI colour sequence", () => {
    expect(stripControlCharacters("\u001b[31mred\u001b[0m")).toBe("[31mred[0m");
  });

  it("turns a run of line breaks and tabs into one space", () => {
    expect(stripControlCharacters("first\r\nEXTRA LINE")).toBe("first EXTRA LINE");
    expect(stripControlCharacters("a\tb\n\n\nc\vd\fe")).toBe("a b c d e");
  });

  it("removes every C0 control, DEL and every C1 control", () => {
    let all = "";
    for (let code = 0; code <= 0x1f; code++) all += String.fromCharCode(code);
    for (let code = 0x7f; code <= 0x9f; code++) all += String.fromCharCode(code);
    expect(stripControlCharacters(`a${all}b`)).not.toMatch(CONTROL);
  });

  it("leaves printable ASCII and non-ASCII text as it is", () => {
    const text = "@scope/pkg-name_1.2 · 79/100 — café 日本語";
    expect(stripControlCharacters(text)).toBe(text);
  });
});

describe("sanitizeRegistryValue", () => {
  it("cleans strings in nested objects and arrays and keeps other values", () => {
    const answer = {
      name: "pkg\u001b[2J",
      trustLevel: 3,
      trustScore: 0.8,
      found: true,
      lastScannedAt: null,
      securityProfile: {
        criticalCount: 0,
        knownCves: ["CVE-1\r\nEXTRA", { id: "GHSA-\u0007x" }],
      },
    };
    expect(sanitizeRegistryValue(answer)).toEqual({
      name: "pkg[2J",
      trustLevel: 3,
      trustScore: 0.8,
      found: true,
      lastScannedAt: null,
      securityProfile: {
        criticalCount: 0,
        knownCves: ["CVE-1 EXTRA", { id: "GHSA-x" }],
      },
    });
  });

  it("returns a copy and leaves the value it was given unchanged", () => {
    const answer = { name: "pkg\u001b[2J", nested: { status: "ok\n" } };
    const cleaned = sanitizeRegistryValue(answer);
    expect(cleaned).not.toBe(answer);
    expect(answer.name).toBe("pkg\u001b[2J");
    expect(answer.nested.status).toBe("ok\n");
  });

  it("passes undefined, null, numbers and booleans through", () => {
    expect(sanitizeRegistryValue(undefined)).toBeUndefined();
    expect(sanitizeRegistryValue(null)).toBeNull();
    expect(sanitizeRegistryValue(7)).toBe(7);
    expect(sanitizeRegistryValue(false)).toBe(false);
  });

  it("keeps a __proto__ key as plain data", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": "yes\\n"}, "name": "pkg"}');
    const cleaned = sanitizeRegistryValue(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(cleaned.name).toBe("pkg");
  });
});

describe("capLength", () => {
  it("returns text at or under the cap unchanged", () => {
    expect(capLength("CVE-2025-0001", 40)).toBe("CVE-2025-0001");
    expect(capLength("x".repeat(40), 40)).toBe("x".repeat(40));
  });

  it("cuts longer text to the cap and ends it with three dots", () => {
    const capped = capLength("x".repeat(41), 40);
    expect(capped).toHaveLength(40);
    expect(capped).toBe(`${"x".repeat(37)}...`);
  });

  it("does not cut a surrogate pair in half (#195)", () => {
    // The emoji's two code units sit at indexes 36 and 37; a cut at 37 would
    // keep only its high half.
    const capped = capLength(`${"x".repeat(36)}\u{1F600}${"y".repeat(10)}`, 40);
    expect(capped).toBe(`${"x".repeat(36)}...`);
    // With the u flag, \p{Cs} matches only a surrogate that is not in a pair.
    expect(capped).not.toMatch(/\p{Cs}/u);
  });

  it("keeps a surrogate pair that ends right at the cut (#195)", () => {
    const capped = capLength(`${"x".repeat(35)}\u{1F600}${"y".repeat(10)}`, 40);
    expect(capped).toBe(`${"x".repeat(35)}\u{1F600}...`);
    expect(capped).toHaveLength(40);
  });
});
