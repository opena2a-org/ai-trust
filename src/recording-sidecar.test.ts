/**
 * The front-door recording is pinned to its tape, its build and its fixture,
 * and paced for a person to read.
 *
 * docs/vhs/check.gif is rendered by docs/vhs/record-check.sh from
 * docs/vhs/check.tape, and docs/vhs/check.json is the sidecar that render
 * writes (schema demo-sidecar/2): which build ran, when, on which fixture, at
 * which pace, and what came out. This suite keeps the committed files in
 * agreement, so a change to any one of them without a new render fails here:
 * - the sidecar opens with the demo-sidecar/2 keys, in order; the keys the
 *   render wrote before that schema follow them;
 * - the sidecar's version is the version in package.json, and the build is
 *   that version as published on npm (prerelease false): only a release
 *   render is embedded;
 * - the commands the tape types on screen are the sidecar's commands and the
 *   text capture's commands, in order;
 * - the tape, the GIF, the fixture and the VHS patch hash to what the sidecar
 *   recorded, and the MP4 was remuxed with its index first (faststart);
 * - the pace: 100-140 ms a character, 600-1000 ms before each Enter, each
 *   step's output on one screen of at most 30 rows and held for at least
 *   max(3 s, 1 s per 4 lines, its narration at 2.5 words a second + 0.5 s)
 *   and at most 12 s, at most 45 s in all, a GIF of at most 3 MB and 1200 px;
 * - each step is named in the tape, the sidecar and the narration file, in
 *   the same order, and its anchor frame is committed;
 * - the README embeds the GIF between demo markers, the caption under it is
 *   built from the sidecar, and the line under the caption links the capture
 *   and the sidecar;
 * - the tape, the text capture and the README embed carry no local path.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const SIDECAR_PATH = "docs/vhs/check.json";
const TAPE = "docs/vhs/check.tape";
const CAPTURE = "docs/vhs/check-capture.txt";
const NARRATION = "docs/vhs/check.narration.json";
const RENDER_SCRIPT = "docs/vhs/record-check.sh";
const PATCH = "docs/vhs/docker/vhs-0.12.0-render-context.patch";
const EDITS = ["setup not shown", "waits shortened", "hard cuts and labelled skips"];
const WORDS = /\/Users\/|\/home\/|~\/|phase [0-9]/;
const VERSION_OR_DATE = /[0-9]+\.[0-9]+\.[0-9]+|20[0-9]{2}-[0-9]{2}-[0-9]{2}/;
const EMBED_START = "<!-- demo:check:start -->";
const EMBED_END = "<!-- demo:check:end -->";
/** The demo-sidecar/2 keys, in the order the schema gives them. */
const SCHEMA_KEYS = [
  "schema", "surfaceClass", "tool", "version", "prerelease", "script", "scriptSha256", "recorder",
  "commands", "steps", "fixture", "fixtureSha", "fixtureUncommittedChanges", "ranAtUtc",
  "durationSeconds", "outputs", "capture", "narration", "pace", "exitCodes", "meteredCostUsd",
];
/** The keys the render wrote before demo-sidecar/2. They stay, after the schema's keys. */
const EARLIER_KEYS = [
  "tape", "tapeSha256", "registryHost", "fixturePath", "hostname", "columns", "rows", "framerate",
  "gifsicle", "gifFrames", "gifFullScreenFrames", "renderedPixelSize", "wallClockSeconds",
  "vhsPatchSha256", "edits", "environment",
];
/** The pace rule for a recorded front door. */
const PACE = {
  typingSpeedMs: { min: 100, max: 140 },
  preEnterHoldMs: { min: 600, max: 1000 },
  minHoldSeconds: 3,
  linesPerSecond: 4,
  narrationWordsPerSecond: 2.5,
  narrationPadSeconds: 0.5,
  maxHoldSeconds: 12,
  maxLineChars: 72,
  maxRows: 30,
  maxSeconds: 45,
  maxGifBytes: 3_000_000,
  maxGifWidth: 1200,
};

interface Output {
  path: string;
  bytes: number;
  sha256: string;
}

interface Sidecar {
  schema?: string;
  surfaceClass?: string;
  tool: string;
  version: string;
  prerelease?: boolean;
  script?: string;
  scriptSha256: string;
  recorder?: { name: string; version: string; container: string };
  commands: string[];
  steps?: Array<{ id: string; title: string; anchorFrame: string }>;
  fixture: string;
  fixtureSha: string;
  fixtureUncommittedChanges: number;
  ranAtUtc: string;
  durationSeconds: number;
  outputs: {
    gif: Output & { width?: number; height?: number; frames?: number };
    mp4: Output & { committed: boolean; faststart?: boolean };
    frames: string[];
  };
  capture?: string;
  narration?: string;
  pace?: { typingSpeedMs: number; preEnterHoldMs: number; minHoldSeconds: number; maxLineChars: number };
  exitCodes: number[];
  meteredCostUsd: number;
  tape: string;
  tapeSha256: string;
  npmIntegrity?: string;
  packedFromCommit?: string;
  registryHost: string;
  hostname: string;
  columns: number;
  rows: number;
  framerate: number;
  gifsicle: string;
  gifFrames: number;
  wallClockSeconds: number;
  vhsPatchSha256: string;
  edits: string[];
}

interface Narration {
  schema: string;
  tool: string;
  version: string;
  steps: Array<{ id: string; text: string }>;
}

type TapeCommand =
  | { kind: "step"; id: string; title: string }
  | { kind: "type"; text: string }
  | { kind: "sleep"; ms: number }
  | { kind: "enter" }
  | { kind: "screenshot"; path: string }
  | { kind: "other"; line: string };

interface TapeStep {
  id: string;
  title: string;
  /** The commands after the step's `# step:` comment, up to the next one. */
  commands: TapeCommand[];
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");
}

/** What a viewer sees the tape do: its commands outside `Hide`..`Show`, in order, with the `# step:` comments. */
function onScreen(tape: string): TapeCommand[] {
  const commands: TapeCommand[] = [];
  let hidden = false;
  for (const raw of tape.split("\n")) {
    const line = raw.trim();
    if (line === "Hide") hidden = true;
    else if (line === "Show") hidden = false;
    else if (!hidden && line !== "") {
      const step = line.match(/^# step: (\S+)\s*(.*)$/);
      const typed = line.match(/^Type(?:@\S+)?\s+(["'`])(.*)\1$/);
      const sleep = line.match(/^Sleep\s+([0-9.]+)(ms|s)?$/);
      const screenshot = line.match(/^Screenshot\s+(\S+)$/);
      if (step) commands.push({ kind: "step", id: step[1], title: step[2] });
      else if (typed) commands.push({ kind: "type", text: typed[2] });
      else if (sleep) commands.push({ kind: "sleep", ms: Number(sleep[1]) * (sleep[2] === "ms" ? 1 : 1000) });
      else if (/^Enter(\s+\d+)?$/.test(line)) commands.push({ kind: "enter" });
      else if (screenshot) commands.push({ kind: "screenshot", path: screenshot[1] });
      else if (!line.startsWith("#")) commands.push({ kind: "other", line });
    }
  }
  return commands;
}

/** The `Type` lines a viewer sees: those outside `Hide`..`Show`, in order. */
function typedOnScreen(tape: string): string[] {
  return onScreen(tape).flatMap((command) => (command.kind === "type" ? [command.text] : []));
}

/** The tape's steps: each `# step: <id> <title>` comment and the commands up to the next one. */
function tapeSteps(tape: string): TapeStep[] {
  const commands = onScreen(tape);
  const starts = commands.flatMap((command, i) => (command.kind === "step" ? [i] : []));
  return starts.map((start, n) => {
    const step = commands[start] as { kind: "step"; id: string; title: string };
    return { id: step.id, title: step.title, commands: commands.slice(start + 1, starts[n + 1]) };
  });
}

/** The commands of a step after its Enter: the wait for its output, its screenshot and its hold. */
function afterEnter(step: TapeStep): TapeCommand[] {
  const enter = step.commands.findIndex((command) => command.kind === "enter");
  return enter === -1 ? [] : step.commands.slice(enter + 1);
}

/** How long a step's output stays on screen: the `Sleep`s after its Enter, up to the next step. */
function holdSeconds(step: TapeStep): number {
  return afterEnter(step).reduce((sum, command) => sum + (command.kind === "sleep" ? command.ms : 0), 0) / 1000;
}

/** The text capture's lines for each command: from its `$ ` line through its `[exit N]` line. */
function captureBlocks(capture: string): string[][] {
  const blocks: string[][] = [];
  for (const line of capture.split("\n")) {
    const current = blocks[blocks.length - 1];
    if (line.startsWith("$ ")) blocks.push([line]);
    else if (current && !/^\[exit \d+\]$/.test(current[current.length - 1])) current.push(line);
  }
  return blocks;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The width and height in a GIF's logical screen descriptor. */
function gifSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(resolve(ROOT, path));
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** The index of the first non-blank line after `from`, or -1. */
function nextNonBlank(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) if (lines[i].trim() !== "") return i;
  return -1;
}

const sidecar = JSON.parse(read(SIDECAR_PATH)) as Sidecar;
const manifest = JSON.parse(read("package.json")) as { name: string; version: string };
const tape = read(TAPE);
const capture = read(CAPTURE);
const narration = existsSync(resolve(ROOT, NARRATION)) ? (JSON.parse(read(NARRATION)) as Narration) : null;
const readme = read("README.md").split("\n");
const embedStart = readme.findIndex((line) => line.trim() === EMBED_START);
const embedEnd = readme.findIndex((line) => line.trim() === EMBED_END);

describe(`${SIDECAR_PATH} pins the recording to the build`, () => {
  it("records the version in package.json", () => {
    expect(sidecar.tool).toBe(manifest.name);
    expect(sidecar.version).toBe(manifest.version);
  });

  it("names the build it ran: a published integrity or the commit it was packed from", () => {
    const published = /^sha512-[A-Za-z0-9+/]+=*$/.test(sidecar.npmIntegrity ?? "");
    const packed = /^[0-9a-f]{40}$/.test(sidecar.packedFromCommit ?? "");
    expect(published !== packed, "exactly one of npmIntegrity and packedFromCommit").toBe(true);
    expect(sidecar.prerelease, "prerelease is true exactly when the build was packed from a checkout").toBe(packed);
  });

  it("is a release render: the published package, prerelease false", () => {
    expect(sidecar.prerelease, "only a release render is embedded").toBe(false);
    expect(sidecar.npmIntegrity).toMatch(/^sha512-/);
  });

  it("opens with the demo-sidecar/2 keys, in order, before any other key", () => {
    expect(Object.keys(sidecar).slice(0, SCHEMA_KEYS.length)).toEqual(SCHEMA_KEYS);
    expect(sidecar.schema).toBe("demo-sidecar/2");
    expect(sidecar.surfaceClass).toBe("terminal");
    expect([sidecar.script, sidecar.capture, sidecar.narration]).toEqual([TAPE, CAPTURE, NARRATION]);
    expect(sidecar.recorder).toEqual({
      name: "vhs",
      version: expect.stringMatching(/^v?[0-9]+\.[0-9]+\.[0-9]+/),
      container: "docs/vhs/docker/Dockerfile",
    });
  });

  it("keeps the provenance keys it wrote before demo-sidecar/2", () => {
    expect(EARLIER_KEYS.filter((key) => !(key in sidecar))).toEqual([]);
    expect(sidecar.tape).toBe(TAPE);
    expect(sidecar.ranAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(sidecar.registryHost).toMatch(/^[a-z0-9.-]+$/);
    expect(sidecar.wallClockSeconds).toBeGreaterThan(0);
    expect(sidecar.gifFrames).toBeGreaterThan(0);
    expect(Array.isArray(sidecar.outputs.frames)).toBe(true);
  });

  it("was rendered at 120 columns, at most 30 rows, 10 frames a second, on host laptop, at no metered cost", () => {
    const rows = Number(/^Set Rows (\d+)$/m.exec(tape)?.[1]);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(PACE.maxRows);
    expect(tape).toMatch(/^Set Columns 120$/m);
    expect(tape).toMatch(/^Set Framerate 10$/m);
    expect([sidecar.columns, sidecar.rows, sidecar.framerate]).toEqual([120, rows, 10]);
    expect(sidecar.hostname).toBe("laptop");
    expect(sidecar.meteredCostUsd).toBe(0);
    expect(sidecar.fixtureUncommittedChanges).toBe(0);
    expect(sidecar.gifsicle).toContain("-O3 --lossy=40");
    expect(sidecar.edits.filter((edit) => !EDITS.includes(edit))).toEqual([]);
  });

  it("stays inside the size and length budgets", () => {
    expect(sidecar.durationSeconds).toBeGreaterThan(0);
    expect(sidecar.durationSeconds).toBeLessThanOrEqual(PACE.maxSeconds);
    expect(sidecar.outputs.gif.bytes).toBeLessThanOrEqual(PACE.maxGifBytes);
    expect(sidecar.outputs.gif.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(PACE.maxGifWidth);
    expect(sidecar.outputs.mp4.bytes).toBeGreaterThan(0);
    expect(sidecar.outputs.mp4.bytes).toBeLessThanOrEqual(1_500_000);
    expect(sidecar.outputs.mp4.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the MP4 was remuxed with its index first (faststart), and is not committed", () => {
    expect(sidecar.outputs.mp4.faststart).toBe(true);
    expect(sidecar.outputs.mp4.committed).toBe(false);
  });
});

describe(`${SIDECAR_PATH} pins the recording to the committed files`, () => {
  it("the tape hashes to scriptSha256 and tapeSha256", () => {
    expect(sidecar.scriptSha256).toBe(sha256(TAPE));
    expect(sidecar.tapeSha256).toBe(sidecar.scriptSha256);
  });

  it("the GIF is the one the render wrote", () => {
    expect(statSync(resolve(ROOT, sidecar.outputs.gif.path)).size).toBe(sidecar.outputs.gif.bytes);
    expect(sha256(sidecar.outputs.gif.path)).toBe(sidecar.outputs.gif.sha256);
  });

  it("the GIF's width, height and frame count are the ones the sidecar records", () => {
    const { width, height, frames } = sidecar.outputs.gif;
    expect({ width, height }).toEqual(gifSize(sidecar.outputs.gif.path));
    expect(frames).toBe(sidecar.gifFrames);
  });

  it("the fixture is the sample project the audit step read", () => {
    expect(sidecar.fixtureSha).toBe(sha256("docs/demo/package.json"));
  });

  it("the VHS patch is the one the container was built with", () => {
    expect(sidecar.vhsPatchSha256).toBe(sha256(PATCH));
  });

  it("held frames listed in the sidecar are committed", () => {
    expect(sidecar.outputs.frames.filter((frame) => !existsSync(resolve(ROOT, frame)))).toEqual([]);
  });
});

describe("the pace the tape sets", () => {
  const commands = onScreen(tape);
  const typingSpeedMs = Number(/^Set TypingSpeed (\d+)ms$/m.exec(tape)?.[1]);
  const preEnterHoldsMs = commands.flatMap((command, i) => {
    if (command.kind !== "enter") return [];
    const before = commands[i - 1];
    return [before?.kind === "sleep" ? before.ms : 0];
  });

  it("types 100-140 ms a character", () => {
    expect(typingSpeedMs).toBeGreaterThanOrEqual(PACE.typingSpeedMs.min);
    expect(typingSpeedMs).toBeLessThanOrEqual(PACE.typingSpeedMs.max);
  });

  it("holds 600-1000 ms before each Enter on screen", () => {
    expect(preEnterHoldsMs.length).toBeGreaterThan(0);
    for (const ms of preEnterHoldsMs) {
      expect(ms).toBeGreaterThanOrEqual(PACE.preEnterHoldMs.min);
      expect(ms).toBeLessThanOrEqual(PACE.preEnterHoldMs.max);
    }
  });

  it("the sidecar's pace is the tape's", () => {
    expect(new Set(preEnterHoldsMs).size, "one hold before every Enter").toBe(1);
    expect(sidecar.pace).toEqual({
      typingSpeedMs,
      preEnterHoldMs: preEnterHoldsMs[0],
      minHoldSeconds: PACE.minHoldSeconds,
      maxLineChars: PACE.maxLineChars,
    });
  });

  it(`types no line longer than ${PACE.maxLineChars} characters`, () => {
    expect(typedOnScreen(tape).filter((command) => command.length > PACE.maxLineChars)).toEqual([]);
  });

  it("shows each step's output on one screen and holds it long enough to read, at most 12 s", () => {
    const steps = tapeSteps(tape);
    const blocks = captureBlocks(capture);
    const rows = Number(/^Set Rows (\d+)$/m.exec(tape)?.[1]);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBe(blocks.length);
    const problems: string[] = [];
    steps.forEach((step, i) => {
      const lines = blocks[i].length;
      const spoken = narration?.steps.find((s) => s.id === step.id)?.text ?? "";
      const needed = Math.max(
        PACE.minHoldSeconds,
        lines / PACE.linesPerSecond,
        words(spoken) / PACE.narrationWordsPerSecond + PACE.narrationPadSeconds,
      );
      const hold = holdSeconds(step);
      if (lines > rows) problems.push(`${step.id}: ${lines} lines of output on ${rows} rows`);
      if (hold < needed) problems.push(`${step.id}: held ${hold} s, needs ${needed} s`);
      if (hold > PACE.maxHoldSeconds) problems.push(`${step.id}: held ${hold} s, more than ${PACE.maxHoldSeconds} s`);
    });
    expect(problems).toEqual([]);
  });
});

describe("each step is named in the tape, the sidecar and the narration file", () => {
  const steps = tapeSteps(tape);

  it("a `# step:` comment with a title comes right before each command typed on screen", () => {
    expect(steps.map((step) => step.commands[0])).toEqual(typedOnScreen(tape).map((text) => ({ kind: "type", text })));
    expect(steps.filter((step) => step.title.trim() === "").map((step) => step.id)).toEqual([]);
  });

  it("the sidecar's steps and the narration's steps are the tape's, in order", () => {
    expect(steps.length).toBeGreaterThan(0);
    expect((sidecar.steps ?? []).map(({ id, title }) => ({ id, title }))).toEqual(
      steps.map(({ id, title }) => ({ id, title })),
    );
    expect((narration?.steps ?? []).map((step) => step.id)).toEqual(steps.map((step) => step.id));
  });

  it("each step's anchor frame is the screenshot the tape takes after its Enter, and is committed", () => {
    const screenshots = steps.map((step) => {
      const screenshot = afterEnter(step).find((command) => command.kind === "screenshot");
      return screenshot?.kind === "screenshot" ? screenshot.path : null;
    });
    expect((sidecar.steps ?? []).map((step) => step.anchorFrame)).toEqual(screenshots);
    for (const frame of screenshots) {
      expect(frame).not.toBeNull();
      const path = resolve(ROOT, frame ?? "");
      expect(existsSync(path), `${frame} is committed`).toBe(true);
      expect(readFileSync(path).subarray(0, 8).toString("hex"), `${frame} is a PNG`).toBe("89504e470d0a1a0a");
    }
  });

  it("the narration file is demo-narration/1 for the recorded tool and version, a sentence per step", () => {
    expect(narration, `${NARRATION} exists`).not.toBeNull();
    expect([narration?.schema, narration?.tool, narration?.version]).toEqual([
      "demo-narration/1",
      sidecar.tool,
      sidecar.version,
    ]);
    expect((narration?.steps ?? []).filter((step) => step.text.trim() === "")).toEqual([]);
  });
});

describe("what the tape types is what was recorded", () => {
  const typed = typedOnScreen(tape);

  it("the tape's on-screen commands equal the sidecar's commands, in order", () => {
    expect(typed.length).toBeGreaterThan(0);
    expect(typed).toEqual(sidecar.commands);
  });

  it("the text capture ran the same commands, in order", () => {
    const captured = capture
      .split("\n")
      .filter((line) => line.startsWith("$ "))
      .map((line) => line.slice(2));
    expect(captured).toEqual(sidecar.commands);
  });

  it("the tape requires every binary it types on screen", () => {
    const required = new Set([...tape.matchAll(/^Require (\S+)$/gm)].map((m) => m[1]));
    const binaries = typed.flatMap((command) => {
      const [first, second] = command.split(/\s+/);
      return first === "npx" ? [first, second] : [first];
    });
    expect(binaries.filter((binary) => !required.has(binary))).toEqual([]);
  });

  it("the tape has no alias, no pipe and no echo on screen", () => {
    expect(tape).not.toMatch(/\balias\b/);
    expect(typed.filter((command) => /\||\becho\b/.test(command))).toEqual([]);
  });
});

describe("the README embeds the recording with a caption from the sidecar", () => {
  const embeds = readme.flatMap((line, i) => (line.includes(`](${sidecar.outputs.gif.path})`) ? [i] : []));
  const caption = nextNonBlank(readme, embeds[0] ?? readme.length);
  const links = caption === -1 ? -1 : nextNonBlank(readme, caption);

  it(`between one ${EMBED_START} and one ${EMBED_END}`, () => {
    expect(readme.filter((line) => line.trim() === EMBED_START)).toHaveLength(1);
    expect(readme.filter((line) => line.trim() === EMBED_END)).toHaveLength(1);
    expect(embedStart).toBeGreaterThan(-1);
    expect(embedStart).toBeLessThan(embedEnd);
  });

  it("the GIF is embedded once, inside the markers, with no version, date or local path on its line", () => {
    expect(embeds).toHaveLength(1);
    const line = readme[embeds[0]];
    expect(line.startsWith("!["), "an embedded image").toBe(true);
    expect(embeds[0]).toBeGreaterThan(embedStart);
    expect(embeds[0]).toBeLessThan(embedEnd);
    expect(line).not.toMatch(VERSION_OR_DATE);
    expect(line).not.toMatch(WORDS);
  });

  it("the line under it is the caption built from the sidecar's tool, version and date", () => {
    expect(readme[caption]).toBe(`Recorded with ${sidecar.tool} ${sidecar.version} on ${sidecar.ranAtUtc.slice(0, 10)}`);
  });

  it("the line under the caption links the capture and the sidecar, and the block ends after it", () => {
    expect(readme[links]).toContain(`](${CAPTURE})`);
    expect(readme[links]).toContain(`](${SIDECAR_PATH})`);
    expect(nextNonBlank(readme, links)).toBe(embedEnd);
  });
});

describe("words in the recording's text", () => {
  it("the tape, the text capture and the README embed carry no local path", () => {
    expect(tape).not.toMatch(WORDS);
    expect(capture).not.toMatch(WORDS);
    expect(readme.slice(Math.max(embedStart, 0), embedEnd + 1).join("\n")).not.toMatch(WORDS);
  });
});

describe(RENDER_SCRIPT, () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    it(`refuses to start when ${key} is set`, () => {
      const before = read(SIDECAR_PATH);
      const run = spawnSync("bash", [resolve(ROOT, RENDER_SCRIPT)], {
        env: { PATH: process.env.PATH, [key]: "set" },
        encoding: "utf8",
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(`${key} is set`);
      expect(read(SIDECAR_PATH)).toBe(before);
    });
  }
});
