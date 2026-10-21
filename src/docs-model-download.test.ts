/**
 * A deep scan downloads the scanner's classifier model the first time it
 * runs (#123). The pinned scanner's classifier lists the files it downloads,
 * the host it downloads them from and the directory it stores them in. The
 * local scan section of docs/commands.md names each of them, and the README's
 * note on the download links to that section, so a scanner version that
 * downloads other files fails here until the docs name them.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const LOCAL_SCAN_HEADING = "### Local scan and registry lookup";
const LOCAL_SCAN_LINK = "](docs/commands.md#local-scan-and-registry-lookup)";

/** The root of the hackmyagent package Node resolves for ai-trust: the copy ai-trust runs. */
function scannerRoot(): string {
  let dir = dirname(createRequire(import.meta.url).resolve("hackmyagent"));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "hackmyagent") return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("No hackmyagent package.json above the resolved entry point");
    dir = parent;
  }
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return "";
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const classifier = readFileSync(
  join(scannerRoot(), "dist", "nanomind-core", "inference", "tme-classifier.js"),
  "utf8",
);
// MODEL_FILES: one { name, sha256 } entry for each file the classifier downloads.
const files = [...classifier.matchAll(/\{ name: '([^']+)', sha256: '[0-9a-f]{64}' \}/g)].map((m) => m[1]);
// HF_BASE: the URL each file name is appended to.
const host = classifier.match(/const HF_BASE = 'https:\/\/([^/']+)\//)?.[1] ?? "";
// DOWNLOAD_DIR: the home directory joined with these names.
const dirNames = classifier.match(/const DOWNLOAD_DIR = .*homedir\)\(\), ((?:'[^']+'(?:, )?)+)\);/)?.[1] ?? "";
const downloadDir = `~/${[...dirNames.matchAll(/'([^']+)'/g)].map((m) => m[1]).join("/")}`;

describe("docs: the model a deep scan downloads (#123)", () => {
  const localScan = section(read("docs/commands.md"), LOCAL_SCAN_HEADING);

  it("reads the files, the host and the directory from the pinned scanner", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(host).not.toBe("");
    expect(dirNames).not.toBe("");
  });

  it("the local scan section of docs/commands.md names the host, the directory and each file", () => {
    expect(localScan).not.toBe("");
    expect(localScan).toContain(host);
    expect(localScan).toContain(`\`${downloadDir}\``);
    expect(files.filter((file) => !localScan.includes(`\`${file}\``))).toEqual([]);
  });

  it("the README's note on the download names the host and the directory and links to that section", () => {
    const note = read("README.md")
      .split("\n")
      .find((l) => l.includes("Deep scans download"));
    expect(note).toBeDefined();
    expect(note).toContain(host);
    expect(note).toContain(`\`${downloadDir}\``);
    expect(note).toContain(LOCAL_SCAN_LINK);
  });
});
