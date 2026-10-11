/**
 * CHANGELOG.md carries a dated section for the version package.json declares.
 *
 * 0.7.5 and 0.7.6 were published with no section of their own: the 0.7.5
 * entries stayed under "## Unreleased" and the 0.7.6 changes were never
 * written down. The release workflow's build job runs this suite before the
 * publish job, so a version bump that lands without its section now fails
 * before anything is published instead of being found months later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const CHANGELOG = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
const MANIFEST_VERSION = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }
).version;

const RELEASE_HEADING = /^## (\d+)\.(\d+)\.(\d+) \(\d{4}-\d{2}-\d{2}\)$/;

const sectionHeadings = CHANGELOG.split("\n").filter((line) => line.startsWith("## "));
const releaseHeadings = sectionHeadings.filter((line) => line !== "## Unreleased");

function versionOf(heading: string): [number, number, number] {
  const match = RELEASE_HEADING.exec(heading);
  if (!match) throw new Error(`Not a release heading: ${heading}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

describe("CHANGELOG.md", () => {
  it("has a dated section for the version in package.json", () => {
    const current = releaseHeadings.filter((line) => line.startsWith(`## ${MANIFEST_VERSION} (`));
    expect(current, `no "## ${MANIFEST_VERSION} (YYYY-MM-DD)" heading`).toHaveLength(1);
    expect(current[0]).toMatch(RELEASE_HEADING);
  });

  it("writes every release heading as '## X.Y.Z (YYYY-MM-DD)'", () => {
    const malformed = releaseHeadings.filter((line) => !RELEASE_HEADING.test(line));
    expect(malformed).toEqual([]);
  });

  it("keeps Unreleased first and release sections newest first", () => {
    const unreleasedAt = sectionHeadings.indexOf("## Unreleased");
    expect(unreleasedAt === -1 || unreleasedAt === 0).toBe(true);

    const versions = releaseHeadings.map(versionOf);
    for (let i = 1; i < versions.length; i++) {
      expect(
        compareVersions(versions[i - 1], versions[i]),
        `${releaseHeadings[i - 1]} must come before ${releaseHeadings[i]} and differ from it`,
      ).toBeGreaterThan(0);
    }
  });
});
