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
const SCANNER_PIN = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies.hackmyagent;

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

  // The scanner pin decides which scanner an install resolves, so every move
  // of it is a user-visible change. The `0.23.11` -> `0.24.0` move went out
  // with no entry, which left a gap in the pin history. Walking back from the
  // current pin through the recorded moves must reach every recorded move.
  it("records every move of the hackmyagent pin, back from the current one", () => {
    // "Bumped the pinned `hackmyagent` scanner `A` → `B`" (Unreleased entries)
    const BUMPED = /pinned `hackmyagent` scanner `\^?(\d+\.\d+\.\d+)` → `(\d+\.\d+\.\d+)`/g;
    // "The `hackmyagent` scanner is pinned exactly at `B`, up from `^A`" (0.7.6)
    const PINNED_AT =
      /`hackmyagent` scanner is pinned exactly at `(\d+\.\d+\.\d+)`, up from `\^?(\d+\.\d+\.\d+)`/g;
    const moves = [
      ...[...CHANGELOG.matchAll(BUMPED)].map((m) => ({ from: m[1], to: m[2] })),
      ...[...CHANGELOG.matchAll(PINNED_AT)].map((m) => ({ from: m[2], to: m[1] })),
    ];
    expect(moves.length).toBeGreaterThan(0);

    const visited = new Set<number>();
    let current = SCANNER_PIN.replace(/^[\^~]/, "");
    for (;;) {
      const index = moves.findIndex((move, i) => move.to === current && !visited.has(i));
      if (index === -1) break;
      visited.add(index);
      current = moves[index].from;
    }

    expect(
      visited.size > 0,
      `no entry records the move to the current pin hackmyagent ${SCANNER_PIN}`,
    ).toBe(true);
    const unreached = moves.filter((_, i) => !visited.has(i));
    expect(
      unreached,
      `no entry records the move to hackmyagent ${current}, so the pin history stops there`,
    ).toEqual([]);
  });

  // Unreleased is the next release's notes, so a sentence there that says which
  // hackmyagent is pinned has to name the pin package.json declares. Two
  // entries written while the pin was `0.25.0` still said `hackmyagent` "stays
  // pinned `0.25.0`" after a later entry moved the pin to `0.33.2`.
  it("names the pin package.json declares wherever Unreleased says which hackmyagent is pinned", () => {
    // "`hackmyagent` stays pinned `A`", "`hackmyagent` is pinned exactly at `A`",
    // "the pinned `hackmyagent` A", "the pinned `hackmyagent@A`"
    const PINNED_NOW =
      /`hackmyagent` (?:stays|is) pinned (?:exactly at )?`\^?(\d+\.\d+\.\d+)`|\b[Tt]he pinned `hackmyagent(?:` |@)(\d+\.\d+\.\d+)/g;
    const lines = CHANGELOG.split("\n");
    const start = lines.indexOf("## Unreleased");
    const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
    const unreleased = start === -1 ? [] : lines.slice(start + 1, end === -1 ? undefined : end);
    const pin = SCANNER_PIN.replace(/^[\^~]/, "");

    const stale = unreleased.flatMap((line, i) =>
      [...line.matchAll(PINNED_NOW)]
        .map((m) => m[1] ?? m[2])
        .filter((version) => version !== pin)
        .map((version) => `CHANGELOG.md:${start + 2 + i} names hackmyagent ${version} as pinned`),
    );
    expect(stale, `package.json pins hackmyagent ${pin}`).toEqual([]);
  });

  // The entry for the saved-state end-to-end test says which scanner requests
  // that test does not send to its capture server. It named the model download
  // as the only one, while the preload's `redirect` also passes loopback
  // requests to other ports (the NanoMind daemon) through unchanged. Each early
  // return in `redirect` is listed here with the words the entry uses for it,
  // so an exclusion added to the preload fails here until the entry names it.
  it("names each kind of scanner request the saved-state test does not capture", () => {
    const exclusions = [
      {
        preload: 'if (url.hostname === "huggingface.co") return new URL("/model-download" + url.pathname, stub);',
        entry: /classifier model download a deep scan makes when no model is installed, which a local stub answers with a 404/,
      },
      {
        preload:
          "if (LOOPBACK.includes(url.hostname) && url.port !== stub.port && url.port !== capture.port) return null;",
        entry:
          /loopback requests to ports other than the stub's and the capture server's, which go through unchanged and which a deep scan makes to the NanoMind daemon/,
      },
    ];

    const test = readFileSync(resolve(ROOT, "src/scanner/hma-saved-state.test.ts"), "utf8");
    const start = test.indexOf("const redirect = (url) => {");
    const end = test.indexOf("\n    return to;\n", start);
    expect(start, "no `redirect` in the saved-state test's preload").toBeGreaterThan(-1);
    expect(end, "no `return to;` closing the preload's `redirect`").toBeGreaterThan(start);
    const earlyReturns = test
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => / return /.test(line));
    expect(earlyReturns).toEqual(exclusions.map((e) => e.preload));

    const entry = CHANGELOG.split("\n").find((line) =>
      line.startsWith("- **The bundled scanner runs with your saved choices out of its reach"),
    );
    expect(entry, "no entry for the saved-state end-to-end test").toBeDefined();
    for (const exclusion of exclusions) expect(entry).toMatch(exclusion.entry);
  });
});
