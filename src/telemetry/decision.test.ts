/**
 * decideContribution over the cells of the decision table that
 * src/contribution-decision-table.test.ts runs through the built CLI. Each
 * row here is that table's row in the function's terms, recorded from the
 * same runs: a prompt, the scan ping (sent on the decision made before any
 * answer), whether the scans were sent (after the answer "y" when asked),
 * the choice saved, whether ai-trust counted the scan, and the lines.
 */
import { describe, it, expect } from "vitest";
import { decideContribution, SHARE_QUESTION, type ContributionCommand } from "./decision.js";

type Flag = "--contribute" | "--no-contribute" | "none";
type Saved = "absent" | "true" | "false" | '"true"' | '"false"' | "invalid";
type Stdin = "terminal" | "pipe";

const FLAG: Record<Flag, boolean | undefined> = {
  "--contribute": true,
  "--no-contribute": false,
  none: undefined,
};

/** What readContributeChoice returns for each saved file of the table. */
const READING: Record<Saved, boolean | undefined> = {
  absent: undefined,
  true: true,
  false: false,
  '"true"': undefined,
  '"false"': undefined,
  invalid: undefined,
};

const ASKED = [
  "  You just scanned 1 package(s) with no community trust data.",
  "  Sharing pseudonymous results helps other developers make informed decisions.",
  "  (Future scans will auto-share. Change: ai-trust config contribute off)",
];
const HOW_TO_SHARE = [
  "  1 package(s) scanned for the first time. Share with the community:",
  "    ai-trust audit <file> --scan-missing --contribute",
];

type Row = [ContributionCommand, Flag, Saved, Stdin, boolean, boolean, boolean, boolean | undefined, boolean, string[]];
const TABLE: Row[] = [
  // command, flag, saved, stdin, prompt, scan ping, sent, saved choice, counted, lines
  ["check", "--contribute", "absent", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "absent", "pipe", false, true, true, undefined, true, []],
  ["check", "--contribute", "true", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "true", "pipe", false, true, true, undefined, true, []],
  ["check", "--contribute", "false", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "false", "pipe", false, true, true, undefined, true, []],
  ["check", "--contribute", "\"true\"", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "\"true\"", "pipe", false, true, true, undefined, true, []],
  ["check", "--contribute", "\"false\"", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "\"false\"", "pipe", false, true, true, undefined, true, []],
  ["check", "--contribute", "invalid", "terminal", false, true, true, undefined, true, []],
  ["check", "--contribute", "invalid", "pipe", false, true, true, undefined, true, []],
  ["check", "--no-contribute", "absent", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "absent", "pipe", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "true", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "true", "pipe", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "false", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "false", "pipe", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "\"true\"", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "\"true\"", "pipe", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "\"false\"", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "\"false\"", "pipe", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "invalid", "terminal", false, false, false, undefined, true, []],
  ["check", "--no-contribute", "invalid", "pipe", false, false, false, undefined, true, []],
  ["check", "none", "absent", "terminal", false, false, false, undefined, true, []],
  ["check", "none", "absent", "pipe", false, false, false, undefined, true, []],
  ["check", "none", "true", "terminal", false, true, true, undefined, true, []],
  ["check", "none", "true", "pipe", false, true, true, undefined, true, []],
  ["check", "none", "false", "terminal", false, false, false, undefined, true, []],
  ["check", "none", "false", "pipe", false, false, false, undefined, true, []],
  ["check", "none", "\"true\"", "terminal", false, false, false, undefined, true, []],
  ["check", "none", "\"true\"", "pipe", false, false, false, undefined, true, []],
  ["check", "none", "\"false\"", "terminal", false, false, false, undefined, true, []],
  ["check", "none", "\"false\"", "pipe", false, false, false, undefined, true, []],
  ["check", "none", "invalid", "terminal", false, false, false, undefined, true, []],
  ["check", "none", "invalid", "pipe", false, false, false, undefined, true, []],
  ["audit", "--contribute", "absent", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "absent", "pipe", false, true, true, undefined, true, []],
  ["audit", "--contribute", "true", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "true", "pipe", false, true, true, undefined, true, []],
  ["audit", "--contribute", "false", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "false", "pipe", false, true, true, undefined, true, []],
  ["audit", "--contribute", "\"true\"", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "\"true\"", "pipe", false, true, true, undefined, true, []],
  ["audit", "--contribute", "\"false\"", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "\"false\"", "pipe", false, true, true, undefined, true, []],
  ["audit", "--contribute", "invalid", "terminal", false, true, true, undefined, true, []],
  ["audit", "--contribute", "invalid", "pipe", false, true, true, undefined, true, []],
  ["audit", "--no-contribute", "absent", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "absent", "pipe", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "true", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "true", "pipe", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "false", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "false", "pipe", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "\"true\"", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "\"true\"", "pipe", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "\"false\"", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "\"false\"", "pipe", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "invalid", "terminal", false, false, false, undefined, false, []],
  ["audit", "--no-contribute", "invalid", "pipe", false, false, false, undefined, false, []],
  ["audit", "none", "absent", "terminal", true, false, true, true, true, ASKED],
  ["audit", "none", "absent", "pipe", false, false, false, undefined, false, HOW_TO_SHARE],
  ["audit", "none", "true", "terminal", false, true, true, undefined, true, []],
  ["audit", "none", "true", "pipe", false, true, true, undefined, true, []],
  ["audit", "none", "false", "terminal", false, false, false, undefined, false, []],
  ["audit", "none", "false", "pipe", false, false, false, undefined, false, HOW_TO_SHARE],
  ["audit", "none", "\"true\"", "terminal", true, false, true, true, true, ASKED],
  ["audit", "none", "\"true\"", "pipe", false, false, false, undefined, false, HOW_TO_SHARE],
  ["audit", "none", "\"false\"", "terminal", true, false, true, true, true, ASKED],
  ["audit", "none", "\"false\"", "pipe", false, false, false, undefined, false, HOW_TO_SHARE],
  ["audit", "none", "invalid", "terminal", true, false, true, true, true, ASKED],
  ["audit", "none", "invalid", "pipe", false, false, false, undefined, false, HOW_TO_SHARE],
];

describe("decideContribution", () => {
  it.each(TABLE)("%s %s, saved %s, stdin %s", (command, flag, saved, stdin, prompt, ping, sent, save, counted, lines) => {
    const inputs = {
      command,
      flag: FLAG[flag],
      saved: READING[saved],
      interactive: stdin === "terminal",
      scanned: 1,
    };
    const first = decideContribution(inputs);
    // The answer the table gives a prompt is "y".
    const last = first.prompt ? decideContribution({ ...inputs, answer: true }) : first;
    const printed = [...first.lines, ...(first.prompt ? last.lines : [])]
      .map((l) => l.text)
      .filter((t) => t !== "");

    expect({
      prompt: first.prompt,
      ping: first.send,
      sent: last.send,
      save: last.save,
      counted: last.countScans,
      printed,
    }).toEqual({ prompt, ping, sent, save, counted, printed: lines });
  });

  it("asks the question the table shows", () => {
    expect(SHARE_QUESTION).toBe("Share these scans with the community?");
  });

  it("saves a no and then shares, counts and prints nothing", () => {
    const decision = decideContribution({
      command: "audit",
      flag: undefined,
      saved: undefined,
      interactive: true,
      scanned: 1,
      answer: false,
    });
    expect(decision).toEqual({ prompt: false, send: false, save: false, lines: [], countScans: false });
  });

  it("names the number of packages scanned", () => {
    const base = { command: "audit" as const, flag: undefined, saved: undefined, scanned: 3 };
    expect(decideContribution({ ...base, interactive: true }).lines[1].text).toBe(
      "  You just scanned 3 package(s) with no community trust data.",
    );
    expect(decideContribution({ ...base, interactive: false }).lines[1].text).toBe(
      "  3 package(s) scanned for the first time. Share with the community:",
    );
  });

  it("styles the lines as audit printed them", () => {
    const asked = decideContribution({ command: "audit", flag: undefined, saved: undefined, interactive: true, scanned: 1 });
    expect(asked.lines.map((l) => l.style)).toEqual([undefined, "bold", "gray", undefined]);
    const howTo = decideContribution({ command: "audit", flag: undefined, saved: undefined, interactive: false, scanned: 1 });
    expect(howTo.lines.map((l) => l.style)).toEqual([undefined, "gray", "cyan"]);
    const yes = decideContribution({ command: "audit", flag: undefined, saved: undefined, interactive: true, scanned: 1, answer: true });
    expect(yes.lines.map((l) => l.style)).toEqual(["gray"]);
  });
});
