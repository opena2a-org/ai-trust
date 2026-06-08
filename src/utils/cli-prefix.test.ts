/**
 * Tests for the AI_TRUST_CLI_PREFIX self-citation helper (issue #191).
 */

import { describe, it, expect, afterEach } from "vitest";
import { checkCitation } from "./cli-prefix.js";

describe("checkCitation", () => {
  afterEach(() => {
    delete process.env.AI_TRUST_CLI_PREFIX;
  });

  it("returns the native 'ai-trust check' when AI_TRUST_CLI_PREFIX is unset", () => {
    delete process.env.AI_TRUST_CLI_PREFIX;
    expect(checkCitation()).toBe("ai-trust check");
  });

  it("returns the prefix when AI_TRUST_CLI_PREFIX is set", () => {
    process.env.AI_TRUST_CLI_PREFIX = "opena2a registry";
    expect(checkCitation()).toBe("opena2a registry");
  });

  it("trims surrounding whitespace from the prefix", () => {
    process.env.AI_TRUST_CLI_PREFIX = "  opena2a registry  ";
    expect(checkCitation()).toBe("opena2a registry");
  });

  it("falls back to native when the prefix is empty/whitespace-only", () => {
    process.env.AI_TRUST_CLI_PREFIX = "   ";
    expect(checkCitation()).toBe("ai-trust check");
    process.env.AI_TRUST_CLI_PREFIX = "";
    expect(checkCitation()).toBe("ai-trust check");
  });

  it("reads the env var at call time (not at module load)", () => {
    delete process.env.AI_TRUST_CLI_PREFIX;
    expect(checkCitation()).toBe("ai-trust check");
    process.env.AI_TRUST_CLI_PREFIX = "opena2a registry";
    expect(checkCitation()).toBe("opena2a registry");
  });
});
