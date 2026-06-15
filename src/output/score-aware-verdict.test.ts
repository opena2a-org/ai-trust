/**
 * Tests for ai-trust's score-aware human verdict (option a,
 * [CHIEF-CPO]+[CHIEF-CA] decision). Both human surfaces must derive from the
 * score-aware enum (safe/warning/blocked), so the terminal never contradicts
 * `--json`. Regression: a high finding on a high-scoring benign third-party
 * package must NOT say "Not safe to ship".
 */
import { describe, it, expect } from "vitest";
import type { VerdictFinding } from "@opena2a/cli-ui";
import {
  buildScoreAwareVerdict,
  type VerdictCounts,
} from "./score-aware-verdict.js";

const noCounts: VerdictCounts = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  total: 0,
};

const counts = (c: Partial<VerdictCounts>): VerdictCounts => {
  const merged = { ...noCounts, ...c };
  merged.total =
    c.total ?? merged.critical + merged.high + merged.medium + merged.low;
  return merged;
};

const finding = (over: Partial<VerdictFinding> = {}): VerdictFinding => ({
  severity: "high",
  name: "Some Finding",
  checkId: "X-001",
  file: "file.ts",
  line: 12,
  ...over,
});

describe("buildScoreAwareVerdict — status maps from the score-aware enum", () => {
  it("blocked → unsafe", () => {
    const v = buildScoreAwareVerdict(
      "blocked",
      counts({ critical: 2 }),
      [finding({ severity: "critical" })],
      { kind: "mcp_server", remote: true },
    );
    expect(v.status).toBe("unsafe");
  });

  it("warning → needs-fix (NOT unsafe)", () => {
    const v = buildScoreAwareVerdict("warning", counts({ high: 1 }), [finding()], {
      kind: "repo",
      remote: false,
    });
    expect(v.status).toBe("needs-fix");
  });

  it("safe → safe", () => {
    const v = buildScoreAwareVerdict("safe", noCounts, [], {
      kind: "package",
      remote: true,
    });
    expect(v.status).toBe("safe");
  });
});

describe("regression: high finding on a high-scoring benign package", () => {
  // repo/benign in the corpus: deriveVerdict='warning', score 90, 1 high.
  const v = buildScoreAwareVerdict(
    "warning",
    counts({ high: 1 }),
    [finding({ name: "Incomplete .gitignore", file: ".gitignore", line: 0 })],
    { kind: "repo", remote: false },
  );

  it("does NOT say 'Not safe to ship' or 'Not safe as-is'", () => {
    expect(v.headline.toLowerCase()).not.toContain("not safe");
    expect(v.message.toLowerCase()).not.toContain("not safe");
  });

  it("reads as a caveat, aligned with the warning verdict", () => {
    expect(v.headline).toContain("Usable with caveats");
    expect(v.message).toContain("Usable with caveats");
    expect(v.status).toBe("needs-fix");
  });
});

describe("headline content", () => {
  it("blocked names only the worst severity bucket (concise)", () => {
    const v = buildScoreAwareVerdict(
      "blocked",
      counts({ critical: 74, high: 81, medium: 40, low: 5 }),
      [finding({ severity: "critical" })],
      { kind: "repo", remote: false },
    );
    expect(v.headline).toBe("Not safe to ship — 74 critical");
    expect(v.headline).not.toContain("high");
  });

  it("safe with no findings → 'No security issues found'", () => {
    const v = buildScoreAwareVerdict("safe", noCounts, [], {
      kind: "package",
      remote: true,
    });
    expect(v.headline).toBe("No security issues found");
    expect(v.message).toContain("looks safe to use");
  });

  it("safe with low/medium findings → 'Looks safe — N minor findings'", () => {
    const v = buildScoreAwareVerdict(
      "safe",
      counts({ low: 3, medium: 2 }),
      [finding({ severity: "medium", name: "overprivileged_capability" })],
      { kind: "mcp_server", remote: true },
    );
    expect(v.headline).toBe("Looks safe — 5 minor findings");
    expect(v.message).toContain("Looks safe to use");
    expect(v.status).toBe("safe");
  });
});

describe("message names the lead finding (action-oriented)", () => {
  it("includes 'name in file:line' and '+ N more'", () => {
    const v = buildScoreAwareVerdict(
      "blocked",
      counts({ critical: 1, high: 2 }),
      [
        finding({ severity: "critical", name: "Exposed Credential", file: "mcp.json", line: 10 }),
        finding({ severity: "high" }),
        finding({ severity: "high" }),
      ],
      { kind: "mcp_server", remote: true },
    );
    expect(v.message).toContain("Exposed Credential in mcp.json:10");
    expect(v.message).toContain("+ 2 more");
  });

  it("remote vs local guidance differs", () => {
    const remote = buildScoreAwareVerdict("blocked", counts({ critical: 1 }), [finding({ severity: "critical" })], { kind: "x", remote: true });
    const local = buildScoreAwareVerdict("blocked", counts({ critical: 1 }), [finding({ severity: "critical" })], { kind: "x", remote: false });
    expect(remote.message).toContain("Do not depend on this package");
    expect(local.message).toContain("Fix before using in production");
  });
});
