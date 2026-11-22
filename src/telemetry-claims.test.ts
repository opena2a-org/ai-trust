/**
 * No public sentence says that usage telemetry protects, warns, detects for or
 * informs anyone else. No sentence makes "telemetry" of any channel the subject
 * of a protection, detection, signature, advisory or intelligence claim; the
 * opt-in channels are named by what they carry.
 *
 * The gate runs one fixed pattern, pinned below by its sha256, over the
 * tracked *.md, *.mdx, *.tsx, *.ts, *.js and *.html files, minus paths
 * matching tests, fixtures and changelogs. A new hit fails until it is
 * reviewed: a line that is not a claim goes on ALLOWED with its reason.
 * This repository's baseline is 0 lines, so ALLOWED is empty.
 *
 * In a git work tree the files read are the tracked ones. A source archive has
 * no git metadata, so there the tree is walked instead, leaving out the
 * directories an install or a build adds.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATTERN = String.raw`(?i)(usage (telemetry|data|events?)|telemetry)[^.\n]{0,140}(?<!runtime-)(protect|immun|threat intel|intelligence|safer|keeps? (you|everyone|users) safe|helps? (everyone|other users|the community))|(?<!runtime-)(protect|immun|intelligence|safer)[^.\n]{0,140}(usage (telemetry|data|events?)|\btelemetry\b)`;
const PATTERN_SHA256 = "807b542ac5abb446a074933e74eba2dfaf0c09a0c4a650c395d66a6808dcf8a7";
// PCRE's leading (?i) has no JavaScript form; it is the RegExp's i flag here.
const CLAIM = new RegExp(PATTERN.replace(/^\(\?i\)/, ""), "i");
const PUBLIC_TEXT = /\.(md|mdx|tsx|ts|js|html)$/;
const NOT_PUBLIC = /(^|\/)(__)?(tests?|fixtures?)(__)?\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)CHANGELOG[^/]*$/i;
// Not part of the source tree: dependencies, build and coverage output, git.
const UNTRACKED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/** Reviewed lines that are not claims, as "<path>: <line>", each with its reason. */
const ALLOWED: ReadonlyArray<{ line: string; reason: string }> = [];

interface Hit {
  path: string;
  number: number;
  text: string;
}

/** Tracked files, or null when root is not inside a git work tree. */
function trackedFiles(root: string): string[] | null {
  // A hook can export GIT_DIR and its peers, which point git at another
  // repository than the one root is in.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

/** Every file under root outside UNTRACKED_DIRS, as a path relative to root. */
function walkedFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!UNTRACKED_DIRS.has(entry.name)) out.push(...walkedFiles(root, path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function publicTextFiles(root: string): string[] {
  return (trackedFiles(root) ?? walkedFiles(root)).filter(
    (path) => PUBLIC_TEXT.test(path) && !NOT_PUBLIC.test(path),
  );
}

function hits(root: string): Hit[] {
  const out: Hit[] = [];
  for (const path of publicTextFiles(root)) {
    readFileSync(join(root, path), "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (CLAIM.test(text)) out.push({ path, number: i + 1, text });
      });
  }
  return out;
}

const allowKey = (hit: Hit) => `${hit.path}: ${hit.text}`;
const shown = (hit: Hit) => `${hit.path}:${hit.number}: ${hit.text}`;

describe("public text: no sentence says usage telemetry protects anyone", () => {
  it("carries the pinned pattern byte for byte", () => {
    expect(PATTERN.startsWith("(?i)")).toBe(true);
    expect(createHash("sha256").update(PATTERN).digest("hex")).toBe(PATTERN_SHA256);
  });

  it("matches the claim in either order, and not a sentence that names what a channel carries", () => {
    expect(CLAIM.test("Usage telemetry helps everyone detect new threats.")).toBe(true);
    expect(CLAIM.test("Threat intelligence from your telemetry reaches every install.")).toBe(true);
    expect(CLAIM.test("USAGE DATA KEEPS EVERYONE SAFE")).toBe(true);
    expect(CLAIM.test("Usage telemetry sends the command name, success and duration.")).toBe(false);
    expect(CLAIM.test("Events go to the runtime-protection telemetry service.")).toBe(false);
    expect(CLAIM.test("Usage telemetry is on by default. Scanning protects your project.")).toBe(false);
  });

  it("reports a matching line of a public text file, and reads no test, fixture, changelog, installed or other file", () => {
    const claim = "Usage telemetry helps everyone detect new threats.";
    const tree: Record<string, string> = {
      "README.md": `# Tool\n\n${claim}\n`,
      "docs/guide.md": "Usage telemetry sends the command name.\n",
      "CHANGELOG.md": `${claim}\n`,
      "src/cli.test.ts": `// ${claim}\n`,
      "test/fixtures/page.html": `<p>${claim}</p>\n`,
      "node_modules/dep/index.js": `// ${claim}\n`,
      "notes.txt": `${claim}\n`,
    };
    const scratch = mkdtempSync(join(tmpdir(), "ai-trust-claims-"));
    try {
      for (const [path, text] of Object.entries(tree)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), text);
      }
      expect(hits(scratch).map(shown)).toEqual([`README.md:3: ${claim}`]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("no line of this repository's public text matches, but the reviewed ones", () => {
    expect(publicTextFiles(ROOT)).toEqual(
      expect.arrayContaining(["README.md", "src/commands/audit.ts", "src/commands/check.ts"]),
    );
    const found = hits(ROOT);
    const allowed = new Set(ALLOWED.map(({ line }) => line));
    expect(found.filter((hit) => !allowed.has(allowKey(hit))).map(shown)).toEqual([]);
    // An entry goes with its line.
    const matched = new Set(found.map(allowKey));
    expect(ALLOWED.filter(({ line }) => !matched.has(line))).toEqual([]);
  });
});
