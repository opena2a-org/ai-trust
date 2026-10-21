/**
 * SECURITY.md is the one place that states how to report a vulnerability and
 * when we reply. CONTRIBUTING.md stated its own address and a 24-hour response
 * while SECURITY.md stated 48 hours and a preferred route CONTRIBUTING.md did
 * not mention, so a reporter read two different commitments. STATUS.md said
 * stable releases have security patches triaged within 24 hours, a third.
 *
 * These checks hold that: CONTRIBUTING.md links SECURITY.md and restates
 * neither the address nor a response window, STATUS.md links SECURITY.md, the
 * README, STATUS.md and the Markdown under docs/ state no response window, and
 * SECURITY.md states one.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const RESPONSE_WINDOW = /\bwithin \d+ (business )?(hours?|days?)\b/i;
const REPORT_ADDRESS = "info@opena2a.org";

function markdownUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = relative(ROOT, join(ROOT, dir, e.name));
    if (e.isDirectory()) return markdownUnder(rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

const windowLines = (rel: string) =>
  read(rel)
    .split("\n")
    .filter((l) => RESPONSE_WINDOW.test(l));

describe("security reports: one policy", () => {
  it("CONTRIBUTING.md links SECURITY.md for the reporting route", () => {
    expect(read("CONTRIBUTING.md")).toMatch(/\]\(SECURITY\.md\)/);
  });

  it("CONTRIBUTING.md does not restate the reporting address", () => {
    expect(read("CONTRIBUTING.md")).not.toContain(REPORT_ADDRESS);
  });

  it("STATUS.md links SECURITY.md for security handling", () => {
    expect(read("STATUS.md")).toMatch(/\]\(SECURITY\.md\)/);
  });

  it.each([
    "README.md",
    "CONTRIBUTING.md",
    "STATUS.md",
    ...markdownUnder("docs"),
  ])(
    "%s states no response window",
    (doc) => {
      expect(windowLines(doc)).toEqual([]);
    },
  );

  it("SECURITY.md states the response window once", () => {
    expect(windowLines("SECURITY.md")).toHaveLength(1);
  });
});

/**
 * The scanner's AIM-001 check fires on this repository's package.json and
 * SECURITY.md records why it does not apply. These checks keep that record
 * tied to the tree it describes: it names the scanner version package.json
 * pins, the keywords it names as the trigger are still in package.json, and
 * no identity file the check looks for exists, since adding one would make
 * the record wrong.
 */
describe("security reports: AIM-001 exemption record", () => {
  const pkg = JSON.parse(read("package.json")) as {
    keywords: string[];
    dependencies: Record<string, string>;
  };
  const section = () => {
    const doc = read("SECURITY.md");
    const start = doc.indexOf("## Scanning this repository");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = doc.indexOf("\n## ", start + 1);
    return doc.slice(start, next === -1 ? undefined : next);
  };

  it("SECURITY.md records the AIM-001 finding against the pinned scanner", () => {
    const text = section();
    expect(text).toContain("`AIM-001`");
    expect(text).toContain(`\`hackmyagent\` ${pkg.dependencies.hackmyagent}`);
  });

  it("the trigger keywords the record names are the package.json keywords the check matches", () => {
    const line = section()
      .split("\n")
      .find((l) => l.startsWith("Trigger keywords:"));
    expect(line).toBeDefined();
    const listed = (line!.match(/`[^`]+`/g) ?? []).map((k) => k.slice(1, -1));
    const matching = pkg.keywords.filter(
      (k) => k.includes("agent") || k.includes("a2a"),
    );
    expect([...listed].sort()).toEqual([...matching].sort());
  });

  it.each([
    "agent-card.json",
    ".well-known/agent-card.json",
    "agent.json",
    ".well-known/agent.json",
    "aim.json",
    ".well-known/aim.json",
  ])("no identity file %s exists at the repository root", (file) => {
    expect(existsSync(join(ROOT, file))).toBe(false);
  });
});
