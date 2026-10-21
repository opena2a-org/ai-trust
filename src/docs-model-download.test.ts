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

/**
 * The files a classifier downloads, the host it downloads them from and the
 * directory it stores them in, read from the text of the compiled classifier.
 * A value the text does not give is an empty list or an empty string.
 */
function modelDownload(classifier: string): { files: string[]; host: string; downloadDir: string } {
  // MODEL_FILES: an entry for each file the classifier downloads, its name
  // under `name` beside other fields such as its sha256.
  const entries = classifier.match(/const MODEL_FILES = \[([\s\S]*?)\];/)?.[1] ?? "";
  const files = [...entries.matchAll(/\bname: ['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  // HF_BASE: the URL each file name is appended to, a quoted string or a
  // template literal whose host is written out.
  const host = classifier.match(/const HF_BASE = ['"`]https:\/\/([^/'"`$]+)\//)?.[1] ?? "";
  // DOWNLOAD_DIR: the home directory joined with these names.
  const dirNames = classifier.match(/const DOWNLOAD_DIR = .*homedir\)\(\), ((?:'[^']+'(?:, )?)+)\);/)?.[1] ?? "";
  const downloadDir = dirNames && `~/${[...dirNames.matchAll(/'([^']+)'/g)].map((m) => m[1]).join("/")}`;
  return { files, host, downloadDir };
}

const { files, host, downloadDir } = modelDownload(
  readFileSync(join(scannerRoot(), "dist", "nanomind-core", "inference", "tme-classifier.js"), "utf8"),
);

describe("docs: the model a deep scan downloads (#123)", () => {
  const localScan = section(read("docs/commands.md"), LOCAL_SCAN_HEADING);

  it("reads the files, the host and the directory from the pinned scanner", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(host).not.toBe("");
    expect(downloadDir).not.toBe("");
  });

  it("reads the files, the host and the directory from a classifier whose file entries carry another field and whose HF_BASE is a template literal (#269)", () => {
    // TypeScript's CommonJS output, target ES2020, for a classifier whose file
    // entries also carry a byte count, one entry written over several lines,
    // and whose HF_BASE is a template literal.
    const classifier = [
      "const HF_REPO = 'opena2a/nanomind-security-classifier';",
      "const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;",
      "const MODEL_FILES = [",
      "    { name: 'tokenizer.json', sha256: 'FAKE-DIGEST-1', bytes: 1000 },",
      "    { name: 'nanomind-tme.onnx', sha256: 'FAKE-DIGEST-2', bytes: 2000 },",
      "    {",
      "        name: 'nanomind-tme.onnx.data',",
      "        sha256: 'FAKE-DIGEST-3',",
      "        bytes: 3000,",
      "    },",
      "];",
      "const DOWNLOAD_DIR = (0, node_path_1.join)((0, node_os_1.homedir)(), '.nanomind', 'models');",
    ].join("\n");
    expect(modelDownload(classifier)).toEqual({
      files: ["tokenizer.json", "nanomind-tme.onnx", "nanomind-tme.onnx.data"],
      host: "huggingface.co",
      downloadDir: "~/.nanomind/models",
    });
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
