import { describe, expect, it } from "vitest";
import {
  deriveTrustVerdict,
  parseRichTarget,
} from "./skill-mcp-check.js";

describe("parseRichTarget", () => {
  it("parses skill: prefix", () => {
    expect(parseRichTarget("skill:opena2a/code-review-skill")).toEqual({
      artifactType: "skill",
      name: "opena2a/code-review-skill",
    });
  });

  it("parses mcp: prefix", () => {
    expect(parseRichTarget("mcp:@modelcontextprotocol/server-filesystem")).toEqual({
      artifactType: "mcp",
      name: "@modelcontextprotocol/server-filesystem",
    });
  });

  it("returns null for unprefixed targets", () => {
    expect(parseRichTarget("express")).toBeNull();
    expect(parseRichTarget("@scope/pkg")).toBeNull();
  });

  it("returns null for empty name after prefix", () => {
    expect(parseRichTarget("skill:")).toBeNull();
    expect(parseRichTarget("mcp:")).toBeNull();
  });

  it("does not match arbitrary colon-bearing strings", () => {
    expect(parseRichTarget("npm:foo")).toBeNull();
    expect(parseRichTarget("https://example.com")).toBeNull();
  });
});

describe("deriveTrustVerdict — parity with HMA's logic (parity F12 / F13)", () => {
  it("BLOCKED for verdict=blocked", () => {
    expect(deriveTrustVerdict("blocked", 2, "completed")).toBe("BLOCKED");
  });

  it("BLOCKED for trustLevel=0", () => {
    expect(deriveTrustVerdict("safe", 0, "completed")).toBe("BLOCKED");
  });

  it("VERIFIED for trustLevel=4", () => {
    expect(deriveTrustVerdict("safe", 4, "completed")).toBe("VERIFIED");
  });

  it("VERIFIED for verdict=verified", () => {
    expect(deriveTrustVerdict("verified", 3, "completed")).toBe("VERIFIED");
  });

  it("LISTED_UNSCANNED when scanStatus is anything but completed", () => {
    expect(deriveTrustVerdict("safe", 2, "error")).toBe("LISTED_UNSCANNED");
    expect(deriveTrustVerdict("safe", 2, "pending")).toBe("LISTED_UNSCANNED");
    expect(deriveTrustVerdict("safe", 2, undefined)).toBe("LISTED_UNSCANNED");
  });

  it("LISTED for completed scans that aren't BLOCKED or VERIFIED", () => {
    expect(deriveTrustVerdict("safe", 2, "completed")).toBe("LISTED");
    expect(deriveTrustVerdict(undefined, 3, "completed")).toBe("LISTED");
  });
});
