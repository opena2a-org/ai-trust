/**
 * Tests for the masking of credential values in scanner finding text.
 */

import { describe, expect, it } from "vitest";
import { maskSecrets } from "./mask-secrets.js";

/**
 * `length` characters of FAKE repeated. A test value in a credential's shape
 * is a head followed by this, put together when the test runs, so no file
 * holds a provider-token-shaped literal and every such value reads as fake.
 */
function fake(length: number): string {
  return "FAKE".repeat(Math.ceil(length / 4)).slice(0, length);
}

describe("maskSecrets", () => {
  it.each([
    ["sk-ant-api0", fake(24)],
    ["sk-ant-api3", fake(24)],
    ["sk-proj-", fake(24)],
    ["sk-", fake(43)],
    ["sk_live_", fake(24)],
    ["sk_test_", fake(24)],
    ["ghp_", fake(36)],
    ["gho_", fake(36)],
    ["ghs_", fake(36)],
    ["ghu_", fake(36)],
    ["github_pat_", `${fake(22)}_${fake(59)}`],
    ["hf_", fake(34)],
    ["glpat-", fake(20)],
    ["npm_", fake(36)],
    ["AKIA", fake(16)],
    ["AIza", fake(35)],
    ["xoxa-", `${fake(10)}-${fake(12)}`],
    ["xoxb-", `${fake(10)}-${fake(12)}`],
    ["xoxp-", `${fake(10)}-${fake(12)}`],
    ["xoxr-", `${fake(10)}-${fake(12)}`],
    ["xoxs-", `${fake(10)}-${fake(12)}`],
    ["SG.", `${fake(22)}.${fake(43)}`],
    ["eyJ", `${fake(20)}.${fake(20)}.${fake(20)}`],
  ])("prints a value after the %s head as the head and 16 *", (head, body) => {
    const value = head + body;
    const masked = maskSecrets(`Credential risk: key ${value} in the prompt`);
    expect(masked).toBe(`Credential risk: key ${head}${"*".repeat(16)} in the prompt`);
    expect(masked).not.toContain(body);
  });

  it("prints one * for each character after the head when there are fewer than 16", () => {
    expect(maskSecrets(`token xoxb-${fake(12)}`)).toBe(`token xoxb-${"*".repeat(12)}`);
  });

  it("masks every value in the text, and the text between them stays", () => {
    const first = `sk-${fake(43)}`;
    const second = `ghp_${fake(36)}`;
    expect(maskSecrets(`a ${first}\\n\\nb ${second}.`)).toBe(
      `a sk-${"*".repeat(16)}\\n\\nb ghp_${"*".repeat(16)}.`,
    );
  });

  it("masks the token text joined to a value with it", () => {
    // A second token joined to the first starts with `_`, which the `ghp_`
    // body does not take.
    expect(maskSecrets(`ghp_${fake(36)}_${fake(36)}`)).toBe(`ghp_${"*".repeat(16)}`);
  });

  it("masks every segment of a token with more than three", () => {
    const token = `eyJ${fake(20)}.${fake(20)}.${fake(20)}.${fake(20)}.${fake(20)}`;
    expect(maskSecrets(`Bearer ${token}.`)).toBe(`Bearer eyJ${"*".repeat(16)}.`);
  });

  it("reads 256 KB of `eyJ-` repeated, which holds no token, in under a second", () => {
    // Every `eyJ` after the first follows a `-`, so only the first is read as
    // a header; a header read from each would scan the rest of the text again
    // from each one.
    const text = "eyJ-".repeat(65_536);
    const start = performance.now();
    expect(maskSecrets(text)).toBe(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("leaves a head that continues a word, and a body shorter than its shape's", () => {
    const text = `task-${fake(30)} risk-${fake(30)} sk-1234 ghp_${fake(19)} AKIA${fake(15)}`;
    expect(maskSecrets(text)).toBe(text);
  });

  it("leaves text with no credential-shaped value, a value with none of the heads, and a value that is already masked", () => {
    for (const text of [
      "Credential read in skill context",
      "Injection risk: systemPrompt field contains override directives",
      `API key for external requests: ${fake(48)}`,
      `Hardcoded secret: sk-${"*".repeat(16)}`,
      "",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });
});
