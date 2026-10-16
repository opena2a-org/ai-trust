/**
 * SECURITY.md is the one place that states how to report a vulnerability and
 * when we reply. CONTRIBUTING.md stated its own address and a 24-hour response
 * while SECURITY.md stated 48 hours and a preferred route CONTRIBUTING.md did
 * not mention, so a reporter read two different commitments.
 *
 * These checks hold that: CONTRIBUTING.md links SECURITY.md and restates
 * neither the address nor a response window, the README and the Markdown under
 * docs/ state no response window, and SECURITY.md states one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

  it.each(["README.md", "CONTRIBUTING.md", ...markdownUnder("docs")])(
    "%s states no response window",
    (doc) => {
      expect(windowLines(doc)).toEqual([]);
    },
  );

  it("SECURITY.md states the response window once", () => {
    expect(windowLines("SECURITY.md")).toHaveLength(1);
  });
});
