/**
 * Tests for the masking of credential values in scanner finding text.
 */

import { describe, expect, it } from "vitest";
import { maskSecrets } from "./mask-secrets.js";

/**
 * `length` characters of FAKE repeated. A test value in a credential's shape
 * is a head followed by this, put together when the test runs, so no file
 * holds a provider-token-shaped literal and every such value reads as fake.
 */
function fake(length: number): string {
  return "FAKE".repeat(Math.ceil(length / 4)).slice(0, length);
}

/**
 * `length` characters of FAKE, fake and digits, picked by multiples of the
 * golden ratio so that no short unit repeats: a value with no head that the
 * scanner reads as a credential, as it reads a random one. Put together when
 * the test runs.
 */
function fakeUnpatterned(length: number): string {
  const alphabet = "FAKEfake0123456789";
  return Array.from(
    { length },
    (_, i) => alphabet[Math.floor(i * 0.6180339887 * alphabet.length) % alphabet.length],
  ).join("");
}

/**
 * Runs with no head of `length` characters and more, filler or with a value at
 * the end, each with its masked form: a read that starts a run at more places
 * than it must reads them in time that grows with the square of `length`.
 */
function runsWithNoHead(length: number): Array<[text: string, masked: string]> {
  const filler = "_".repeat(length);
  const pairs = "ab".repeat(length / 2);
  // Every boundary in the first 38 characters starts a run that has no
  // end boundary 40 or more characters on.
  const noEnd = `${"+a".repeat(19)}${"+".repeat(length)}`;
  return [
    [filler, filler],
    [pairs, pairs],
    [`${filler}${fakeUnpatterned(40)}`, "*".repeat(16)],
    [noEnd, noEnd],
  ];
}

// The time of a read is measured against the same read of PIECES texts of the
// same shape, each a PIECES-th of the length, run in turn at the same moment.
// Both sides run the same code for about as long, so a loaded machine that
// slows the process slows both alike. When the time is linear in the length,
// the one text takes about as long as the PIECES (maskSecrets: 0.3 to 1.8
// times, measured on these texts); when it grows with the square of the
// length, up to PIECES times as long (`rereadingMask`: 7.5 times or more on the
// 8 KB texts). The bound of 4 sits between the two.
const PIECES = 64;
const LINEAR_BOUND = 4;

/**
 * The CPU time of the process, in milliseconds, which leaves out the time the
 * process waits for a CPU. Windows counts that time in steps of its clock
 * tick, about 15.6 ms, so there it is the elapsed time.
 */
const now =
  process.platform === "win32"
    ? () => performance.now()
    : () => {
        const { user, system } = process.cpuUsage();
        return (user + system) / 1000;
      };

/**
 * The time `mask` takes on `text` over the time it takes on `piece` PIECES
 * times: the fastest of five runs of each, taken in turn, so that a pause of
 * the process during one run does not decide the ratio. A slow spell of the
 * machine over a whole measurement can, so the ratio is measured up to three
 * times while it is at or over the bound.
 */
function timeRatio(mask: (text: string) => string, text: string, piece: string): number {
  const measure = (): number => {
    const fastest = { text: Infinity, pieces: Infinity };
    for (let run = 0; run < 5; run++) {
      let start = now();
      mask(text);
      fastest.text = Math.min(fastest.text, now() - start);
      start = now();
      for (let count = 0; count < PIECES; count++) mask(piece);
      fastest.pieces = Math.min(fastest.pieces, now() - start);
    }
    return fastest.text / fastest.pieces;
  };
  let ratio = measure();
  for (let attempt = 1; attempt < 3 && ratio >= LINEAR_BOUND; attempt++) {
    ratio = Math.min(ratio, measure());
  }
  return ratio;
}

/**
 * A masker that reads the run of credential characters from each place in the
 * text again before it masks as maskSecrets does, as a pattern that starts a
 * run at every place in it would: the same text out, in time that grows with
 * the square of the length.
 */
function rereadingMask(text: string): string {
  const runFrom = /[A-Za-z0-9+=_-]*/y;
  for (let at = 0; at < text.length; at++) {
    runFrom.lastIndex = at;
    runFrom.exec(text);
  }
  return maskSecrets(text);
}

describe("maskSecrets", () => {
  it.each([
    ["sk-ant-api0", fake(24)],
    ["sk-ant-api3", fake(24)],
    ["sk-proj-", fake(24)],
    ["sk-", fake(43)],
    ["sk_live_", fake(24)],
    ["sk_test_", fake(24)],
    ["ghp_", fake(36)],
    ["gho_", fake(36)],
    ["ghs_", fake(36)],
    ["ghu_", fake(36)],
    ["github_pat_", `${fake(22)}_${fake(59)}`],
    ["hf_", fake(34)],
    ["glpat-", fake(20)],
    ["npm_", fake(36)],
    ["AKIA", fake(16)],
    ["AIza", fake(35)],
    ["xoxa-", `${fake(10)}-${fake(12)}`],
    ["xoxb-", `${fake(10)}-${fake(12)}`],
    ["xoxp-", `${fake(10)}-${fake(12)}`],
    ["xoxr-", `${fake(10)}-${fake(12)}`],
    ["xoxs-", `${fake(10)}-${fake(12)}`],
    ["SG.", `${fake(22)}.${fake(43)}`],
    ["eyJ", `${fake(20)}.${fake(20)}.${fake(20)}`],
  ])("prints a value after the %s head as the head and 16 *", (head, body) => {
    const value = head + body;
    const masked = maskSecrets(`Credential risk: key ${value} in the prompt`);
    expect(masked).toBe(`Credential risk: key ${head}${"*".repeat(16)} in the prompt`);
    expect(masked).not.toContain(body);
  });

  it("prints one * for each character after the head when there are fewer than 16", () => {
    expect(maskSecrets(`token xoxb-${fake(12)}`)).toBe(`token xoxb-${"*".repeat(12)}`);
  });

  it("masks every value in the text, and the text between them stays", () => {
    const first = `sk-${fake(43)}`;
    const second = `ghp_${fake(36)}`;
    expect(maskSecrets(`a ${first}\\n\\nb ${second}.`)).toBe(
      `a sk-${"*".repeat(16)}\\n\\nb ghp_${"*".repeat(16)}.`,
    );
  });

  it("masks the token text joined to a value with it", () => {
    // A second token joined to the first starts with `_`, which the `ghp_`
    // body does not take.
    expect(maskSecrets(`ghp_${fake(36)}_${fake(36)}`)).toBe(`ghp_${"*".repeat(16)}`);
  });

  it("masks every segment of a token with more than three", () => {
    const token = `eyJ${fake(20)}.${fake(20)}.${fake(20)}.${fake(20)}.${fake(20)}`;
    expect(maskSecrets(`Bearer ${token}.`)).toBe(`Bearer eyJ${"*".repeat(16)}.`);
  });

  it(`reads 256 KB of \`eyJ-\` repeated, which holds no token, in less than ${LINEAR_BOUND} times the time of ${PIECES} texts of 4 KB`, ({
    task,
  }) => {
    // Every `eyJ` after the first follows a `-`, so only the first is read as
    // a header; a header read from each would scan the rest of the text again
    // from each one.
    const text = "eyJ-".repeat(65_536);
    const piece = "eyJ-".repeat(65_536 / PIECES);
    expect(maskSecrets(text)).toBe(text);
    expect(maskSecrets(piece)).toBe(piece);
    const ratio = timeRatio(maskSecrets, text, piece);
    // The measured ratio, for a report that reads the test's meta.
    Object.assign(task.meta, { ratios: [ratio] });
    expect(ratio).toBeLessThan(LINEAR_BOUND);
  }, 120_000);

  it("leaves a head that continues a word, and a body shorter than its shape's", () => {
    const text = `task-${fake(30)} risk-${fake(30)} sk-1234 ghp_${fake(19)} AKIA${fake(15)}`;
    expect(maskSecrets(text)).toBe(text);
  });

  it("leaves text with no credential-shaped value, a value with none of the heads, and a value that is already masked", () => {
    for (const text of [
      "Credential read in skill context",
      "Injection risk: systemPrompt field contains override directives",
      `API key for external requests: ${fake(48)}`,
      `Hardcoded secret: sk-${"*".repeat(16)}`,
      "",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  describe("a value with no head", () => {
    // The scanner's own fallback: a run of 40 or more `A-Z a-z 0-9 + = _`
    // characters between word boundaries is a credential when some window of
    // 40 of its characters is not filler.

    it("is printed as one * for each character, at most 16", () => {
      const value = fakeUnpatterned(46);
      const masked = maskSecrets(`Credential risk: API Key for external requests: ${value}\\n\\nTool tips`);
      expect(masked).toBe(`Credential risk: API Key for external requests: ${"*".repeat(16)}\\n\\nTool tips`);
      expect(masked).not.toContain(value.slice(0, 8));
    });

    it("is masked at 40 characters and left at 39", () => {
      expect(maskSecrets(`key ${fakeUnpatterned(40)}.`)).toBe(`key ${"*".repeat(16)}.`);
      const short = `key ${fakeUnpatterned(39)}.`;
      expect(maskSecrets(short)).toBe(short);
    });

    it("takes `+`, `=` and `_` into the value, and ends at `-`, `/`, `.` and a space", () => {
      const joined = `${fakeUnpatterned(20)}+${fakeUnpatterned(9)}=_${fakeUnpatterned(12)}`;
      expect(maskSecrets(`secret ${joined} end`)).toBe(`secret ${"*".repeat(16)} end`);
      for (const separator of ["-", "/", ".", " "]) {
        const text = `${fakeUnpatterned(30)}${separator}${fakeUnpatterned(30)}`;
        expect(maskSecrets(text)).toBe(text);
      }
    });

    it("is masked beside a value with a head, which keeps its head", () => {
      const text = `a sk-${fake(43)} b ${fakeUnpatterned(44)} c`;
      expect(maskSecrets(text)).toBe(`a sk-${"*".repeat(16)} b ${"*".repeat(16)} c`);
    });

    it("is masked whole when filler is joined to it", () => {
      // One run in which `_` fills more than 90%; the window that holds the
      // value is not filler.
      const run = "_".repeat(400) + fakeUnpatterned(40);
      expect(maskSecrets(`token ${run} end`)).toBe(`token ${"*".repeat(16)} end`);
    });

    it("is left when every window of 40 repeats a unit of 4 or fewer characters, or has one character in more than 36 places", () => {
      for (const filler of [
        "_".repeat(47),
        "_=".repeat(25),
        "01".repeat(20),
        "abc".repeat(14),
        "FAKE".repeat(12),
        `${"_".repeat(46)}1`,
        `${"a".repeat(37)}bcd`,
      ]) {
        const text = `Field: ${filler} end`;
        expect(maskSecrets(text)).toBe(text);
      }
    });

    it("is masked when its unit is 5 characters, and when one character has 36 of 40 places", () => {
      expect(maskSecrets(`v ${"FAKE1".repeat(8)}`)).toBe(`v ${"*".repeat(16)}`);
      expect(maskSecrets(`v ${"a".repeat(36)}bcde`)).toBe(`v ${"*".repeat(16)}`);
    });

    it(`reads a run of 1 MB, filler or with a value at its end, in less than ${LINEAR_BOUND} times the time of ${PIECES} runs of 16 KB`, ({
      task,
    }) => {
      const ratios: number[] = [];
      Object.assign(task.meta, { ratios });
      const pieces = runsWithNoHead((1 << 20) / PIECES);
      runsWithNoHead(1 << 20).forEach(([text, masked], shape) => {
        const [piece, pieceMasked] = pieces[shape];
        expect(maskSecrets(text)).toBe(masked);
        expect(maskSecrets(piece)).toBe(pieceMasked);
        ratios.push(timeRatio(maskSecrets, text, piece));
        expect(ratios[shape]).toBeLessThan(LINEAR_BOUND);
      });
    }, 120_000);
  });

  it(`holds a masker that reads the run again from each place in it to ${LINEAR_BOUND} times or more, on the 8 KB texts maskSecrets reads in less`, ({
    task,
  }) => {
    const ratios: Array<{ maskSecrets: number; rereadingMask: number }> = [];
    Object.assign(task.meta, { ratios });
    // The texts of both reads above, at 8 KB: `eyJ-` repeated, and the runs
    // with no head.
    const texts = (length: number): Array<[text: string, masked: string]> => [
      ["eyJ-".repeat(length / 4), "eyJ-".repeat(length / 4)],
      ...runsWithNoHead(length),
    ];
    const pieces = texts(8192 / PIECES);
    texts(8192).forEach(([text, masked], shape) => {
      const [piece] = pieces[shape];
      expect(rereadingMask(text)).toBe(masked);
      ratios.push({
        maskSecrets: timeRatio(maskSecrets, text, piece),
        rereadingMask: timeRatio(rereadingMask, text, piece),
      });
      expect(ratios[shape].maskSecrets).toBeLessThan(LINEAR_BOUND);
      expect(ratios[shape].rereadingMask).toBeGreaterThanOrEqual(LINEAR_BOUND);
    });
  }, 120_000);
});
