/**
 * Whether a scan is shared with the registry.
 *
 * `check` and `audit` decide here, from the same inputs, so the two commands
 * cannot answer differently for the same flag and saved choice without the
 * difference being written below. The function reads and writes nothing:
 * the caller reads the saved choice, asks the question when told to, saves
 * the answer, prints the lines and sends the scans.
 *
 * The two commands differ only here:
 *   - `check` never asks, prints nothing about sharing, and counts every scan
 *     toward the opt-in tip.
 *   - `audit` asks on a terminal unless a flag or a saved choice answers,
 *     prints how to share when it cannot ask, and counts a scan toward the
 *     tip only when it shares it.
 * src/contribution-decision-table.test.ts runs both commands over every
 * flag, saved choice and stdin and lists the cells where they differ.
 */

export type ContributionCommand = "check" | "audit";

export interface ContributionInputs {
  command: ContributionCommand;
  /** `--contribute` (true), `--no-contribute` (false), or neither. */
  flag: boolean | undefined;
  /** The saved choice: true, false, or undefined when none is saved. */
  saved: boolean | undefined;
  /** stdin is a terminal, so the question can be answered. */
  interactive: boolean;
  /** How many packages this run scanned. */
  scanned: number;
  /** The answer to the question, once it has been asked. */
  answer?: boolean;
}

export interface ContributionLine {
  text: string;
  style?: "bold" | "gray" | "cyan";
}

export interface ContributionDecision {
  /** Ask SHARE_QUESTION, then decide again with the answer. */
  prompt: boolean;
  /** Send the scans to the registry. */
  send: boolean;
  /** The choice to save in the config file, when there is one. */
  save?: boolean;
  /** Lines to print on stderr, before the question when there is one. */
  lines: ContributionLine[];
  /** Count the scans toward the opt-in tip, which is printed once it is due. */
  countScans: boolean;
}

/** The question `audit` asks; Enter answers yes. */
export const SHARE_QUESTION = "Share these scans with the community?";

const NOTHING: ContributionDecision = {
  prompt: false,
  send: false,
  lines: [],
  countScans: false,
};

export function decideContribution(input: ContributionInputs): ContributionDecision {
  const { command, flag, saved, interactive, scanned, answer } = input;

  // A flag answers for this run either way; without one, only a saved true
  // is consent.
  const consent = flag !== undefined ? flag : saved === true;
  if (consent) return { prompt: false, send: true, lines: [], countScans: true };

  if (command === "check") return { ...NOTHING, countScans: true };

  // audit, not sharing so far.
  if (flag === false) return NOTHING;
  if (!interactive) {
    return {
      ...NOTHING,
      lines: [
        { text: "" },
        {
          text: `  ${scanned} package(s) scanned for the first time. Share with the community:`,
          style: "gray",
        },
        { text: "    ai-trust audit <file> --scan-missing --contribute", style: "cyan" },
      ],
    };
  }
  // A saved no already answers the question.
  if (saved === false) return NOTHING;
  if (answer === undefined) {
    return {
      ...NOTHING,
      prompt: true,
      lines: [
        { text: "" },
        {
          text: `  You just scanned ${scanned} package(s) with no community trust data.`,
          style: "bold",
        },
        {
          text: "  Sharing pseudonymous results helps other developers make informed decisions.",
          style: "gray",
        },
        { text: "" },
      ],
    };
  }
  if (!answer) return { ...NOTHING, save: false };
  return {
    prompt: false,
    send: true,
    save: true,
    lines: [
      {
        text: "  (Future scans will auto-share. Change: ai-trust config contribute off)",
        style: "gray",
      },
    ],
    countScans: true,
  };
}
