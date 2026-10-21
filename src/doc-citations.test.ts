/**
 * Tracked files cite no document the repository does not carry (#124, #264).
 *
 * Source comments and changelog entries pointed readers at planning
 * documents under a `briefs` directory that was never part of this
 * repository, so the rule a comment relied on could not be read by anyone
 * working from a clone. A comment states the rule itself, or cites a file
 * that is tracked here.
 *
 * A changelog entry and a source comment also cited a section of an
 * instructions file the repository does not track (#264), by the file's name
 * and the section's quoted title. A Markdown document cited that way, its path
 * and then the quoted title with an optional version such as v0.3 between
 * them, is a file the repository tracks, named by its path from the
 * repository root.
 *
 * The changelog is checked whole, its released sections included: an entry
 * there also states the rule it followed instead of citing the document
 * that set it.
 *
 * In a git work tree the files checked are the tracked ones. A source archive
 * has no git metadata (#129), so there the tree is walked instead, leaving out
 * the directories an install or a build adds.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const CITATION = /\bbriefs\//;
// A section citation: a Markdown document's path, then the section's title in
// straight or curly quotes, with an optional version such as v0.3 between them.
const SECTION_CITATION = /([\w./-]+\.md)`?(?: +v\d+(?:\.\d+)*)? +["“][^"”]+["”]/g;
// Not part of the source tree: dependencies, build and coverage output, git.
const UNTRACKED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/** Tracked files, or null when ROOT is not inside a git work tree. */
function gitTrackedFiles(): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

/** Every file under ROOT outside UNTRACKED_DIRS, as a path relative to ROOT. */
function walkedFiles(dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!UNTRACKED_DIRS.has(entry.name)) out.push(...walkedFiles(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function trackedFiles(): string[] {
  return gitTrackedFiles() ?? walkedFiles();
}

/** The whole text of a file, or null for a binary file. */
function checkedText(path: string): string | null {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  return text.includes("\0") ? null : text;
}

/** The documents a line cites a section of, each as a path from ROOT. */
function sectionCitations(line: string): string[] {
  return [...line.matchAll(SECTION_CITATION)].map((match) => posix.normalize(match[1]));
}

describe("document citations", () => {
  it("lists tracked files", () => {
    expect(trackedFiles()).toContain("CHANGELOG.md");
  });

  it("the directory walk used outside a git work tree finds the source files and skips installed ones", () => {
    const walked = walkedFiles();
    expect(walked).toContain("CHANGELOG.md");
    expect(walked).toContain("src/doc-citations.test.ts");
    expect(walked.filter((path) => /(^|\/)(node_modules|dist|coverage|\.git)\//.test(path))).toEqual(
      [],
    );
    // In a git work tree the walk covers at least every tracked file.
    const tracked = gitTrackedFiles();
    if (tracked !== null) {
      const walkedSet = new Set(walked);
      expect(tracked.filter((path) => !walkedSet.has(path))).toEqual([]);
    }
  });

  it("checks the whole changelog, its released sections included", () => {
    const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/^## \d+\.\d+\.\d+ /m);
    expect(checkedText("CHANGELOG.md")).toBe(changelog);
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

  it("reads the document out of a section citation, with or without a version", () => {
    expect(sectionCitations('Per `docs/commands.md` v0.3 "Exit codes", ...')).toEqual([
      "docs/commands.md",
    ]);
    expect(sectionCitations('(./docs/commands.md "Exit codes v0.3")')).toEqual([
      "docs/commands.md",
    ]);
    expect(sectionCitations("see docs/commands.md “Exit codes”")).toEqual(["docs/commands.md"]);
    // A file name in code is not a section citation.
    expect(sectionCitations('join(dir, "SKILL.md"), "x"')).toEqual([]);
  });

  it("cites a section only of a Markdown document the repository tracks", () => {
    const files = trackedFiles();
    const tracked = new Set(files);
    const citing: string[] = [];
    for (const path of files) {
      const text = checkedText(path);
      if (text === null) continue;
      text.split("\n").forEach((line, i) => {
        for (const document of sectionCitations(line)) {
          if (!tracked.has(document)) citing.push(`${path}:${i + 1} ${document}`);
        }
      });
    }
    expect(citing).toEqual([]);
  });
});
