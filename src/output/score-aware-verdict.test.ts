/**
 * Tests for ai-trust's score-aware human verdict (option a). Both human
 * surfaces must derive from the score-aware enum (safe/warning/blocked), so
 * the terminal never contradicts `--json`. Regression: a high finding on a high-scoring benign third-party
 * package must NOT say "Not safe to ship".
 */
import { describe, it, expect } from "vitest";
import {
  buildScoreAwareVerdict,
  type LeadFinding,
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

const finding = (over: Partial<LeadFinding> = {}): LeadFinding => ({
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

  it("names a lead whose file is not in the scanned directory as the file it lacks, not a place in it", () => {
    const v = buildScoreAwareVerdict(
      "safe",
      counts({ medium: 1, low: 1 }),
      [
        finding({
          severity: "medium",
          name: "Container Isolation",
          file: "Dockerfile",
          line: undefined,
          absent: true,
        }),
        finding({ severity: "low" }),
      ],
      { kind: "api", remote: false },
    );
    expect(v.message).toContain("Looks safe to use. Container Isolation (no Dockerfile) + 1 more. ");
    expect(v.message).not.toContain("in Dockerfile");
  });

  it("remote vs local guidance differs", () => {
    const remote = buildScoreAwareVerdict("blocked", counts({ critical: 1 }), [finding({ severity: "critical" })], { kind: "x", remote: true });
    const local = buildScoreAwareVerdict("blocked", counts({ critical: 1 }), [finding({ severity: "critical" })], { kind: "x", remote: false });
    expect(remote.message).toContain("Do not depend on this package");
    expect(local.message).toContain("Fix before using in production");
  });
});

describe("local remediation names a command the user can run", () => {
  // ai-trust has no `secure` command; the remediation lives in hackmyagent.
  // A bare `secure --fix` is a dead end for anyone who copies it.
  const bareSecureFix = /(?<!npx hackmyagent )secure --fix/;

  it("warning (local) points at `npx hackmyagent secure --fix`", () => {
    const v = buildScoreAwareVerdict("warning", counts({ high: 1 }), [finding()], {
      kind: "repo",
      remote: false,
    });
    expect(v.message).toContain("npx hackmyagent secure --fix");
    expect(v.message).not.toMatch(bareSecureFix);
  });

  it("safe with minor findings (local) points at `npx hackmyagent secure --fix`", () => {
    const v = buildScoreAwareVerdict(
      "safe",
      counts({ low: 1 }),
      [finding({ severity: "low", name: "Dependency Lock File", file: "package-lock.json" })],
      { kind: "library", remote: false },
    );
    expect(v.message).toContain("npx hackmyagent secure --fix");
    expect(v.message).not.toMatch(bareSecureFix);
  });

  // Without the directory the command acts on the current directory, which
  // is not the one `check --scan-path` scanned.
  it("names the directory a --scan-path scan read, as one shell word", () => {
    const warning = buildScoreAwareVerdict("warning", counts({ high: 1 }), [finding()], {
      kind: "repo",
      remote: false,
      scanPath: "./kitchen-sink",
    });
    expect(warning.message).toContain(
      "Run `npx hackmyagent secure ./kitchen-sink --fix` to auto-remediate where possible, then rescan.",
    );
    expect(warning.message).not.toContain("secure --fix");

    const safe = buildScoreAwareVerdict(
      "safe",
      counts({ low: 1 }),
      [finding({ severity: "low", name: "Missing .gitignore", file: ".gitignore" })],
      { kind: "library", remote: false, scanPath: "/tmp/my dir" },
    );
    expect(safe.message).toContain(
      "Minor findings — run `npx hackmyagent secure '/tmp/my dir' --fix` to auto-remediate where possible.",
    );
  });

  // With the character removed the command would name another directory,
  // and printed as it is the terminal would act on it or hide it (#286).
  it("gives no command for a directory whose name holds a character the terminal would act on or hide", () => {
    // ESC, a CSI sequence, a C1 control and a right-to-left override.
    const rlo = String.fromCodePoint(0x202e);
    for (const scanPath of ["/tmp/ctl\u001bdir", "/tmp/my dir\u001b[31m;rm", "/tmp/ctl\u009bdir", `/tmp/ctl${rlo}dir`]) {
      const warning = buildScoreAwareVerdict("warning", counts({ high: 1 }), [finding()], {
        kind: "repo",
        remote: false,
        scanPath,
      });
      expect(warning.message).toBe("Usable with caveats. Some Finding in file.ts:12. Fix the findings, then rescan.");

      const safe = buildScoreAwareVerdict(
        "safe",
        counts({ low: 1 }),
        [finding({ severity: "low", name: "Missing .gitignore", file: ".gitignore" })],
        { kind: "library", remote: false, scanPath },
      );
      expect(safe.message).toBe("Looks safe to use. Missing .gitignore in .gitignore:12. Minor findings — fix them where needed.");
    }
  });
});
