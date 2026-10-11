/**
 * Tracked files cite no document the repository does not carry (#124).
 *
 * Source comments and changelog entries pointed readers at planning
 * documents under a `briefs` directory that was never part of this
 * repository, so the rule a comment relied on could not be read by anyone
 * working from a clone. A comment states the rule itself, or cites a file
 * that is tracked here.
 *
 * Released CHANGELOG sections are historical records and are not rewritten;
 * the changelog is checked from the top down to its first release heading.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const CITATION = /\bbriefs\//;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.length > 0);
}

function checkedText(path: string): string | null {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  if (text.includes("\0")) return null;
  if (path !== "CHANGELOG.md") return text;
  const lines = text.split("\n");
  const firstRelease = lines.findIndex(
    (line) => line.startsWith("## ") && line !== "## Unreleased",
  );
  return (firstRelease === -1 ? lines : lines.slice(0, firstRelease)).join("\n");
}

describe("document citations", () => {
  it("lists tracked files", () => {
    expect(trackedFiles()).toContain("CHANGELOG.md");
  });

  it("cites no path under a briefs directory in any tracked file", () => {
    const citing: string[] = [];
    for (const path of trackedFiles()) {
      const text = checkedText(path);
      if (text === null) continue;
      text.split("\n").forEach((line, i) => {
        if (CITATION.test(line)) citing.push(`${path}:${i + 1}`);
      });
    }
    expect(citing).toEqual([]);
  });
});
