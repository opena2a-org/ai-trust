/**
 * The README is a short entry point: the first command and its output near
 * the top, one section per job, a Telemetry section, and the reference
 * material in docs/ and CONTRIBUTING.md.
 *
 * These checks hold that form: the word, section and paragraph budgets; no
 * version numbers or dates in the README (the capture sidecar records them),
 * but in the caption of an embedded recording, which its render writes from
 * the recording's sidecar and src/recording-sidecar.test.ts holds to it;
 * AIM named in full where it first appears; a Telemetry section that does not call the telemetry anonymous and whose
 * commands run; use-case guides that do not call contributed scans anonymous; links and anchors that resolve, and no external link to a
 * host a link checker cannot fetch; each reference section at
 * its path under docs/; and a quick-start sample that is a verbatim slice of
 * the recorded capture.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const README = read("README.md");
const LINES = README.split("\n");

const MAX_WORDS = 680;
const MAX_SECTIONS = 6;
const MAX_PARAGRAPH_WORDS = 69;
const LONG_PARAGRAPH_WORDS = 60;
const MAX_LONG_PARAGRAPHS = 1;
const FIRST_SCREEN_LINES = 30;
const QUICK_START = "npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan";
const CAPTURE = "docs/captures/quick-start.txt";
const SIDECAR = "docs/captures/quick-start.json";
const VERSION_OR_DATE = /v?[0-9]+\.[0-9]+\.[0-9]+|20[0-9]{2}-[0-9]{2}-[0-9]{2}/;
const RECORDING_CAPTION = /^Recorded with \S+ [0-9]+\.[0-9]+\.[0-9]+ on 20[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const ANONYMOUS_CLASS = /anonymi[sz]ed|anonymous|irreversible|no personal data|does not identify/i;
const AIM_FIRST_USE = "OpenA2A AIM (Agent Identity Management)";
// npmjs.com package pages answer 403 to any client without a browser session,
// so a link checker can never confirm a link there resolves.
const REFUSES_SCRIPTED_REQUESTS = /(^|\.)npmjs\.com$/;
const FENCE = /^\s*```/;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Blank-line separated blocks; a fenced code block counts as one block. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (current.length) out.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

/**
 * Indexes of the recording captions: lines in the form the record script
 * writes, between a <!-- demo:<name>:start --> and its end marker.
 */
function recordingCaptions(lines: string[]): Set<number> {
  const captions = new Set<number>();
  let open = false;
  lines.forEach((line, i) => {
    const marker = line.trim().match(/^<!-- demo:[a-z0-9-]+:(start|end) -->$/);
    if (marker) open = marker[1] === "start";
    else if (open && RECORDING_CAPTION.test(line)) captions.add(i);
  });
  return captions;
}

/** The anchor GitHub gives a heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Anchors of every heading in a Markdown file, fenced code excluded. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6} (.+)$/);
    if (heading) out.add(slug(heading[1]));
  }
  return out;
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return "";
  const level = lines[start].match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("README: short form", () => {
  it(`has at most ${MAX_WORDS} words`, () => {
    expect(words(README)).toBeLessThanOrEqual(MAX_WORDS);
  });

  it(`has at most ${MAX_SECTIONS} sections`, () => {
    expect(LINES.filter((l) => l.startsWith("## ")).length).toBeLessThanOrEqual(MAX_SECTIONS);
  });

  it(`keeps paragraphs to ${MAX_PARAGRAPH_WORDS} words, with at most ${MAX_LONG_PARAGRAPHS} over ${LONG_PARAGRAPH_WORDS}`, () => {
    const counts = paragraphs(README).map(words);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_PARAGRAPH_WORDS);
    expect(counts.filter((n) => n > LONG_PARAGRAPH_WORDS).length).toBeLessThanOrEqual(MAX_LONG_PARAGRAPHS);
  });

  it("carries no version number or date, but in a recording's caption", () => {
    const captions = recordingCaptions(LINES);
    const hits = LINES.map((l, i) => `${i + 1}: ${l}`).filter(
      (l, i) => !captions.has(i) && VERSION_OR_DATE.test(l.replace(/^\d+: /, "")),
    );
    expect(hits).toEqual([]);
  });

  it(`names AIM as "${AIM_FIRST_USE}" where it first mentions it`, () => {
    // -1 on both sides when the README does not mention AIM at all.
    const first = README.search(/\bAIM\b/);
    const expected = first === -1 ? -1 : first - "OpenA2A ".length;
    expect(README.indexOf(AIM_FIRST_USE)).toBe(expected);
  });

  it(`shows the first command and the start of its output within the first ${FIRST_SCREEN_LINES} lines`, () => {
    const command = LINES.findIndex((l) => l.includes(QUICK_START)) + 1;
    expect(command).toBeGreaterThan(0);
    // The command's own fence closes, then the output fence opens.
    const fences = LINES.map((l, i) => (FENCE.test(l) ? i + 1 : 0)).filter((n) => n > command);
    const outputStart = fences[1] + 1;
    expect(command).toBeLessThanOrEqual(FIRST_SCREEN_LINES);
    expect(outputStart).toBeLessThanOrEqual(FIRST_SCREEN_LINES);
  });
});

describe("README: telemetry disclosure", () => {
  const telemetry = section(README, /^#{2,3} .*telemetry/i);
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ai-trust-readme-"));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("has a Telemetry section", () => {
    expect(telemetry).not.toBe("");
  });

  it("does not call the telemetry anonymous", () => {
    expect(LINES.filter((l) => ANONYMOUS_CLASS.test(l))).toEqual([]);
  });

  it("names the variable that turns usage telemetry off", () => {
    expect(telemetry).toContain("OPENA2A_TELEMETRY=off");
  });

  it("every ai-trust command it names runs", () => {
    const cited = [...telemetry.matchAll(/(?:^|`)ai-trust ((?:telemetry|config contribute) (?:on|off|status))\b/gm)].map(
      (m) => m[1],
    );
    expect(cited).toEqual(expect.arrayContaining(["telemetry off", "config contribute off"]));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      OPENA2A_HOME: join(home, ".opena2a"),
      OPENA2A_TELEMETRY_URL: "http://127.0.0.1:9/event",
      NO_COLOR: "1",
      CI: "true",
    };
    for (const command of new Set(cited)) {
      const run = spawnSync(process.execPath, [join(ROOT, "dist/index.js"), ...command.split(" ")], {
        cwd: home,
        env,
        encoding: "utf8",
        timeout: 20000,
      });
      expect(run.status, `ai-trust ${command}: ${run.stderr}`).toBe(0);
      expect(run.stderr, `ai-trust ${command}`).not.toMatch(/unknown|error/i);
    }
  }, 60000);
});

describe("use-case guides: contributed scans", () => {
  // Each contribution carries a per-device contributor token
  // (docs/use-cases/contribute-scans.md), so the guides hold the README's
  // wording rule. Inline code is left out: it quotes the literal value the
  // scan ping sends.
  const GUIDES = [
    "docs/USE-CASES.md",
    ...readdirSync(join(ROOT, "docs/use-cases"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/use-cases/${f}`),
  ];

  it.each(GUIDES)("%s does not call the data anonymous", (doc) => {
    const prose = read(doc)
      .split("\n")
      .filter((l) => ANONYMOUS_CLASS.test(l.replace(/`[^`]*`/g, "")));
    expect(prose).toEqual([]);
  });
});

describe("README: links", () => {
  const LINKED_DOCS = [
    "README.md",
    "CONTRIBUTING.md",
    "docs/commands.md",
    "docs/install.md",
    "docs/USE-CASES.md",
    ...readdirSync(join(ROOT, "docs/use-cases"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/use-cases/${f}`),
  ];

  it.each(LINKED_DOCS)("every relative link and anchor in %s resolves", (doc) => {
    const text = read(doc);
    const problems: string[] = [];
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?|mailto):/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path ? join(dirname(join(ROOT, doc)), path) : join(ROOT, doc);
      if (!existsSync(file)) {
        problems.push(`missing file ${target}`);
        continue;
      }
      if (anchor && file.endsWith(".md") && !anchors(readFileSync(file, "utf8")).has(anchor)) {
        problems.push(`missing anchor ${target}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("links no external host that refuses scripted requests", () => {
    const external = [...README.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(([, url]) => url);
    expect(external.length).toBeGreaterThan(0);
    expect(external.filter((url) => REFUSES_SCRIPTED_REQUESTS.test(new URL(url).host))).toEqual([]);
  });

  it("each reference section is at its path", () => {
    const moved: Array<[string, string]> = [
      ["From source", "docs/install.md"],
      ["Verifying what was installed", "docs/install.md"],
      ["Scope: AI packages only", "docs/commands.md"],
      ["MCP server shorthand", "docs/commands.md"],
      ["Local scan and registry lookup", "docs/commands.md"],
      ["`audit`", "docs/commands.md"],
      ["`batch`", "docs/commands.md"],
      ["Output options", "docs/commands.md"],
      ["Trust levels", "docs/commands.md"],
      ["Exit codes", "docs/commands.md"],
      ["Use cases", "docs/USE-CASES.md"],
      ["Contributing", "CONTRIBUTING.md"],
      ["Community contribution", "docs/use-cases/contribute-scans.md"],
    ];
    const missing = moved.filter(
      ([heading, file]) => !new RegExp(`^#{1,4} ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(read(file)),
    );
    expect(missing).toEqual([]);
  });
});

describe("README: quick-start capture", () => {
  const sidecar = JSON.parse(read(SIDECAR)) as {
    command: string;
    capturedAt: string;
    exitCode: number;
    outputs: { capture: string };
  };

  it("the sidecar records the command, the time and the capture file", () => {
    expect(sidecar.command).toBe(QUICK_START);
    expect(sidecar.capturedAt).toMatch(/^20\d{2}-\d{2}-\d{2}T/);
    expect(sidecar.exitCode).toBe(0);
    expect(sidecar.outputs.capture).toBe(CAPTURE);
  });

  it("the README sample is a verbatim run of lines from the capture, labeled with a link to it", () => {
    const command = LINES.findIndex((l) => l.includes(QUICK_START));
    const fences = LINES.map((l, i) => (FENCE.test(l) ? i : -1)).filter((i) => i > command);
    const [open, close] = [fences[1], fences[2]];
    const sample = LINES.slice(open + 1, close);
    const label = LINES.slice(fences[0] + 1, open).join("\n");
    expect(label).toContain(`[full output](${CAPTURE})`);

    const captured = read(CAPTURE).split("\n");
    const at = captured.findIndex((_, i) => sample.every((l, j) => captured[i + j] === l));
    expect(sample.length).toBeGreaterThan(0);
    expect(at, "the sample is not a contiguous slice of the capture").toBeGreaterThan(-1);
  });
});
