/**
 * The front-door recording is pinned to its tape, its build and its fixture.
 *
 * docs/vhs/check.gif is rendered by docs/vhs/record-check.sh from
 * docs/vhs/check.tape, and docs/vhs/check.json is the sidecar that render
 * writes: which build ran, when, on which fixture, and what came out. This
 * suite keeps the committed files in agreement, so a change to any one of
 * them without a new render fails here:
 * - the sidecar's version is the version in package.json, so a version bump
 *   needs a new recording before it can ship;
 * - the commands the tape types on screen are the sidecar's commands and the
 *   text capture's commands, in order;
 * - the tape, the GIF, the fixture and the VHS patch hash to what the sidecar
 *   recorded;
 * - the tape, the text capture and the README line carry no local path, and
 *   the README line carries no version and no date (those live in the sidecar).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const SIDECAR_PATH = "docs/vhs/check.json";
const RENDER_SCRIPT = "docs/vhs/record-check.sh";
const PATCH = "docs/vhs/docker/vhs-0.12.0-render-context.patch";
const EDITS = ["setup not shown", "waits shortened", "hard cuts and labelled skips"];
const WORDS = /\/Users\/|\/home\/|~\/|phase [0-9]/;
const VERSION_OR_DATE = /[0-9]+\.[0-9]+\.[0-9]+|20[0-9]{2}-[0-9]{2}-[0-9]{2}/;

interface Output {
  path: string;
  bytes: number;
  sha256: string;
}

interface Sidecar {
  tape: string;
  tapeSha256: string;
  scriptSha256: string;
  commands: string[];
  tool: string;
  version: string;
  npmIntegrity?: string;
  packedFromCommit?: string;
  ranAtUtc: string;
  registryHost: string;
  fixture: string;
  fixtureSha: string;
  fixtureUncommittedChanges: number;
  fixturePath: string;
  hostname: string;
  columns: number;
  rows: number;
  framerate: number;
  gifsicle: string;
  gifFrames: number;
  gifFullScreenFrames: number;
  renderedPixelSize: { width: number; height: number };
  outputs: { gif: Output; mp4: Output; frames: string[]; capture: string };
  durationSeconds: number;
  wallClockSeconds: number;
  meteredCostUsd: number;
  vhsPatchSha256: string;
  edits: string[];
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");
}

/** The `Type` lines a viewer sees: those outside `Hide`..`Show`, in order. */
function typedOnScreen(tape: string): string[] {
  const typed: string[] = [];
  let hidden = false;
  for (const raw of tape.split("\n")) {
    const line = raw.trim();
    if (line === "Hide") hidden = true;
    else if (line === "Show") hidden = false;
    else if (!hidden) {
      const m = line.match(/^Type(?:@\S+)?\s+(["'`])(.*)\1$/);
      if (m) typed.push(m[2]);
    }
  }
  return typed;
}

const sidecar = JSON.parse(read(SIDECAR_PATH)) as Sidecar;
const manifest = JSON.parse(read("package.json")) as { name: string; version: string };
const tape = read(sidecar.tape);
const capture = read(sidecar.outputs.capture);
const readmeLines = read("README.md")
  .split("\n")
  .filter((line) => line.includes(sidecar.outputs.gif.path));

describe(`${SIDECAR_PATH} pins the recording to the build`, () => {
  it("records the version in package.json", () => {
    expect(sidecar.tool).toBe(manifest.name);
    expect(sidecar.version).toBe(manifest.version);
  });

  it("names the build it ran: a published integrity or the commit it was packed from", () => {
    const published = /^sha512-[A-Za-z0-9+/]+=*$/.test(sidecar.npmIntegrity ?? "");
    const packed = /^[0-9a-f]{40}$/.test(sidecar.packedFromCommit ?? "");
    expect(published !== packed, "exactly one of npmIntegrity and packedFromCommit").toBe(true);
  });

  it("carries every provenance key", () => {
    const keys = [
      "tape", "tapeSha256", "scriptSha256", "commands", "tool", "version", "ranAtUtc",
      "registryHost", "fixture", "fixtureSha", "fixtureUncommittedChanges", "fixturePath",
      "hostname", "columns", "rows", "framerate", "gifsicle", "gifFrames", "gifFullScreenFrames",
      "renderedPixelSize", "outputs", "durationSeconds", "wallClockSeconds", "meteredCostUsd",
      "vhsPatchSha256", "edits",
    ];
    expect(keys.filter((key) => !(key in sidecar))).toEqual([]);
    expect(sidecar.ranAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(sidecar.registryHost).toMatch(/^[a-z0-9.-]+$/);
    expect(sidecar.wallClockSeconds).toBeGreaterThan(0);
    expect(sidecar.gifFrames).toBeGreaterThan(0);
    expect(Array.isArray(sidecar.outputs.frames)).toBe(true);
  });

  it("was rendered at 120 by 40, 10 frames a second, on host laptop, at no metered cost", () => {
    expect([sidecar.columns, sidecar.rows, sidecar.framerate]).toEqual([120, 40, 10]);
    expect(tape).toMatch(/^Set Columns 120$/m);
    expect(tape).toMatch(/^Set Rows 40$/m);
    expect(tape).toMatch(/^Set Framerate 10$/m);
    expect(sidecar.hostname).toBe("laptop");
    expect(sidecar.meteredCostUsd).toBe(0);
    expect(sidecar.fixtureUncommittedChanges).toBe(0);
    expect(sidecar.gifsicle).toContain("-O3 --lossy=40");
    expect(sidecar.edits.filter((edit) => !EDITS.includes(edit))).toEqual([]);
  });

  it("stays inside the size and length budgets", () => {
    expect(sidecar.durationSeconds).toBeGreaterThan(0);
    expect(sidecar.durationSeconds).toBeLessThanOrEqual(60);
    expect(sidecar.outputs.gif.bytes).toBeLessThanOrEqual(3_000_000);
    expect(sidecar.outputs.mp4.bytes).toBeGreaterThan(0);
    expect(sidecar.outputs.mp4.bytes).toBeLessThanOrEqual(1_500_000);
    expect(sidecar.outputs.mp4.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe(`${SIDECAR_PATH} pins the recording to the committed files`, () => {
  it("the tape hashes to tapeSha256 and scriptSha256", () => {
    expect(sidecar.tapeSha256).toBe(sha256(sidecar.tape));
    expect(sidecar.scriptSha256).toBe(sidecar.tapeSha256);
  });

  it("the GIF is the one the render wrote", () => {
    expect(statSync(resolve(ROOT, sidecar.outputs.gif.path)).size).toBe(sidecar.outputs.gif.bytes);
    expect(sha256(sidecar.outputs.gif.path)).toBe(sidecar.outputs.gif.sha256);
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

describe("words in the recording's text", () => {
  it("the tape and the text capture carry no local path", () => {
    expect(tape).not.toMatch(WORDS);
    expect(capture).not.toMatch(WORDS);
  });

  it("the README links the recording on one line, with no path, version or date", () => {
    expect(readmeLines).toHaveLength(1);
    const [line] = readmeLines;
    expect(line).not.toMatch(WORDS);
    expect(line).not.toMatch(VERSION_OR_DATE);
    expect(line.startsWith("- ["), "a list item, not an embedded image").toBe(true);
    expect(line).toContain(`](${sidecar.outputs.capture})`);
    expect(line).toContain(`](${SIDECAR_PATH})`);
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
