/**
 * The registry's security profile is read one field at a time (#129).
 *
 * A profile with one count the reader cannot use used to be dropped as a
 * whole, which hid the count that was usable and let "No known issues" stand.
 */
import { describe, it, expect } from "vitest";
import type { TrustAnswer } from "@opena2a/registry-client";
import { hasRecordedIssues, readSecurityProfile } from "./security-profile.js";

function answerWith(securityProfile: unknown): TrustAnswer {
  return {
    name: "some-mcp",
    trustLevel: 3,
    trustScore: 0.8,
    verdict: "passed",
    found: true,
    securityProfile,
  } as unknown as TrustAnswer;
}

describe("readSecurityProfile", () => {
  it("reads both counts and the advisory identifiers", () => {
    expect(
      readSecurityProfile(
        answerWith({ criticalCount: 1, highCount: 2, knownCves: ["CVE-2025-0001"] }),
      ),
    ).toEqual({ criticalCount: 1, highCount: 2, knownCves: ["CVE-2025-0001"] });
  });

  it("keeps a zero count as a reported zero", () => {
    expect(
      readSecurityProfile(answerWith({ criticalCount: 0, highCount: 0, knownCves: [] })),
    ).toEqual({ criticalCount: 0, highCount: 0, knownCves: [] });
  });

  it("returns undefined when the answer carries no profile object", () => {
    expect(readSecurityProfile(answerWith(undefined))).toBeUndefined();
    expect(readSecurityProfile(answerWith(null))).toBeUndefined();
    expect(readSecurityProfile(answerWith("profile"))).toBeUndefined();
  });

  it("keeps the high count when the critical count is null", () => {
    const profile = readSecurityProfile(answerWith({ criticalCount: null, highCount: 2 }));
    expect(profile).toEqual({ highCount: 2, knownCves: [] });
    expect(profile).not.toHaveProperty("criticalCount");
  });

  it("keeps the critical count when the high count is missing", () => {
    expect(readSecurityProfile(answerWith({ criticalCount: 4 }))).toEqual({
      criticalCount: 4,
      knownCves: [],
    });
  });

  it("does not read a negative number as a count", () => {
    const profile = readSecurityProfile(answerWith({ criticalCount: 1, highCount: -1 }));
    expect(profile).toEqual({ criticalCount: 1, knownCves: [] });
  });

  it("does not read a fraction as a count", () => {
    const profile = readSecurityProfile(answerWith({ criticalCount: 1.5, highCount: 3 }));
    expect(profile).toEqual({ highCount: 3, knownCves: [] });
  });

  it("does not read NaN, Infinity, a boolean or an object as a count", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      expect(readSecurityProfile(answerWith({ criticalCount: bad, highCount: 1 }))).toEqual({
        highCount: 1,
        knownCves: [],
      });
    }
  });

  it("reads a string of decimal digits as a count", () => {
    expect(readSecurityProfile(answerWith({ criticalCount: "3", highCount: " 12 " }))).toEqual({
      criticalCount: 3,
      highCount: 12,
      knownCves: [],
    });
  });

  it("does not read a signed, fractional or empty string as a count", () => {
    for (const bad of ["-1", "1.5", "", "3 high", "0x10"]) {
      expect(readSecurityProfile(answerWith({ criticalCount: bad, highCount: 1 }))).toEqual({
        highCount: 1,
        knownCves: [],
      });
    }
  });

  it("reads advisory identifiers when neither count is readable", () => {
    expect(readSecurityProfile(answerWith({ knownCves: ["CVE-2025-0001"] }))).toEqual({
      knownCves: ["CVE-2025-0001"],
    });
  });

  it("reads a single identifier sent as a bare string", () => {
    expect(
      readSecurityProfile(answerWith({ criticalCount: "3", highCount: -1, knownCves: "CVE" })),
    ).toEqual({ criticalCount: 3, knownCves: ["CVE"] });
  });

  it("reads identifiers from id, cveId and cve keys and drops entries without one", () => {
    expect(
      readSecurityProfile(
        answerWith({
          criticalCount: 0,
          highCount: 0,
          knownCves: [
            { id: "GHSA-aaaa-bbbb-cccc" },
            { cveId: "CVE-2025-0002" },
            { cve: " CVE-2025-0003 " },
            { severity: "high" },
            "",
            7,
            null,
          ],
        }),
      )?.knownCves,
    ).toEqual(["GHSA-aaaa-bbbb-cccc", "CVE-2025-0002", "CVE-2025-0003"]);
  });

  it("returns undefined when no count is readable and no identifier is listed", () => {
    expect(readSecurityProfile(answerWith({}))).toBeUndefined();
    expect(readSecurityProfile(answerWith({ knownCves: [] }))).toBeUndefined();
    expect(
      readSecurityProfile(answerWith({ criticalCount: null, highCount: -1, knownCves: 7 })),
    ).toBeUndefined();
  });
});

describe("hasRecordedIssues", () => {
  it("is false for reported zeros and no identifier", () => {
    expect(hasRecordedIssues({ criticalCount: 0, highCount: 0, knownCves: [] })).toBe(false);
  });

  it("is true for a count above zero when the other count was not reported", () => {
    expect(hasRecordedIssues({ highCount: 2, knownCves: [] })).toBe(true);
    expect(hasRecordedIssues({ criticalCount: 1, knownCves: [] })).toBe(true);
  });

  it("is true for an identifier when no count was reported", () => {
    expect(hasRecordedIssues({ knownCves: ["CVE-2025-0001"] })).toBe(true);
  });

  it("is false when the one reported count is zero", () => {
    expect(hasRecordedIssues({ highCount: 0, knownCves: [] })).toBe(false);
  });
});
