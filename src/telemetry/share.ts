/**
 * What `check` and `audit` do with their scans after scanning: decide with
 * decideContribution, then ask, save, print and send as it says.
 */

import chalk from "chalk";
import { measuredNothing } from "../scanner/hma.js";
import type { ScanResult } from "../scanner/index.js";
import { confirm } from "../utils/prompt.js";
import { sendScanPing, submitContribution } from "./contribute.js";
import {
  decideContribution,
  SHARE_QUESTION,
  type ContributionCommand,
  type ContributionInputs,
  type ContributionLine,
} from "./decision.js";
import {
  readContributeChoice,
  recordScanAndMaybeShowTip,
  saveContributeChoice,
} from "./opt-in.js";

export interface SharedScan {
  /**
   * The package name the scan is shared under, without a version. The
   * contribution carries the version read from the downloaded package's
   * manifest.
   */
  name: string;
  scanResult: ScanResult;
}

function printLines(lines: ContributionLine[]): void {
  for (const { text, style } of lines) {
    console.error(style ? chalk[style](text) : text);
  }
}

export async function shareScans(
  command: ContributionCommand,
  scans: SharedScan[],
  opts: {
    /** `--contribute` (true), `--no-contribute` (false), or neither. */
    flag: boolean | undefined;
    registryUrl: string;
    ecosystem: "npm" | "pypi";
    /** The `--type` the package was checked with. */
    type?: string;
    /** The dependency file `audit` read, named in the command that shares the scans. */
    file?: string;
  }
): Promise<void> {
  if (scans.length === 0) return;

  const inputs: ContributionInputs = {
    command,
    flag: opts.flag,
    saved: readContributeChoice(),
    interactive: process.stdin.isTTY === true,
    scanned: scans.length,
    file: opts.file,
  };
  let decision = decideContribution(inputs);

  // A scan that measured nothing has no score to share: the registry would
  // record it as a pass. It is left out of the ping, the summary and the
  // per-check results.
  const measured = scans.filter(({ scanResult }) => !measuredNothing(scanResult));

  // The scan ping names the package, its verdict and score, so it is sent
  // only with the consent the full contribution needs, and never on an
  // answer given after it.
  if (decision.send) {
    for (const { name, scanResult } of measured) {
      sendScanPing(
        name,
        scanResult.verdict,
        Math.round(scanResult.trustScore * 100),
        opts.registryUrl,
        opts.ecosystem
      );
    }
  }

  printLines(decision.lines);
  if (decision.prompt) {
    const answer = await confirm(SHARE_QUESTION, true);
    decision = decideContribution({ ...inputs, answer });
    if (decision.save !== undefined) saveContributeChoice(decision.save);
    printLines(decision.lines);
  }

  if (decision.countScans) {
    const tip = recordScanAndMaybeShowTip();
    if (tip) process.stderr.write(tip + "\n");
  }

  if (decision.send && measured.length > 0) {
    await submitContribution(measured, opts.registryUrl, {
      ecosystem: opts.ecosystem,
      type: opts.type,
    });
  }
}
