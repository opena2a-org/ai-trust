/**
 * Registry strings are made terminal-safe before the text formatters print
 * them (#129).
 */
import { describe, it, expect } from "vitest";
import {
  capLength,
  redactUrlUserinfo,
  sanitizeRegistryValue,
  stripControlCharacters,
  urlWithoutUserinfo,
} from "./sanitize.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Placeholder userinfo planted in the URLs below.
const PLANTED_NAME = "FAKE-USER";
const PLANTED_WORD = "FAKE-PASSWORD";

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

describe("redactUrlUserinfo (#232)", () => {
  it("prints a URL's user name and password in an error message as [redacted]", () => {
    const message =
      "Registry network error: Request cannot be constructed from a URL that includes credentials: " +
      "http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:9/api/v1/trust/batch";
    const redacted = redactUrlUserinfo(message);
    expect(redacted).toBe(
      "Registry network error: Request cannot be constructed from a URL that includes credentials: " +
        "http://[redacted]@127.0.0.1:9/api/v1/trust/batch",
    );
    expect(redacted).not.toContain(PLANTED_NAME);
    expect(redacted).not.toContain(PLANTED_WORD);
  });

  it("redacts a user name alone, a password holding @, and every URL in the text", () => {
    expect(
      redactUrlUserinfo(
        "https://FAKE-USER@a.example.test and http://FAKE-USER:FAKE-PASSWORD@x@b.example.test/p",
      ),
    ).toBe("https://[redacted]@a.example.test and http://[redacted]@b.example.test/p");
  });

  it("leaves an @ outside a URL's user name and password as it is", () => {
    for (const text of [
      "node_modules/@scope/pkg/index.js",
      "ai-trust check @modelcontextprotocol/server-filesystem",
      "https://registry.npmjs.org/@scope%2fpkg",
      "https://api.oa2a.org/api/v1/trust/query?name=@scope/pkg",
      "https://api.oa2a.org/x#@fragment",
      "fetch failed for https://api.oa2a.org while resolving @scope/pkg",
      "Registry network error: fetch failed",
    ]) {
      expect(redactUrlUserinfo(text)).toBe(text);
    }
  });
});

describe("urlWithoutUserinfo (#232)", () => {
  it("prints a URL with a user name or password as its origin and path", () => {
    expect(urlWithoutUserinfo("http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:9")).toBe(
      "http://127.0.0.1:9/",
    );
    expect(urlWithoutUserinfo("https://FAKE-USER@registry.example.test/base")).toBe(
      "https://registry.example.test/base",
    );
  });

  it("returns a URL without them as it was given", () => {
    for (const value of ["http://127.0.0.1:9", "https://api.oa2a.org", "https://registry.example.test/base/"]) {
      expect(urlWithoutUserinfo(value)).toBe(value);
    }
  });

  it("redacts them in a value that does not parse as a URL", () => {
    // Port 99999 is out of range, so the value does not parse.
    expect(urlWithoutUserinfo("http://FAKE-USER:FAKE-PASSWORD@127.0.0.1:99999")).toBe(
      "http://[redacted]@127.0.0.1:99999",
    );
  });
});
