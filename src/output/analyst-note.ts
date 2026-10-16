/**
 * The line `check --analm` prints about the scanner's analyst layer: that it
 * ran, or why it did not.
 */

import type { AnalystLayerStatus } from "../scanner/hma.js";

/** Why the analyst layer did not run when `check` ran no local scan. */
export type NoScanReason = "no-scan" | "registry-library";

const PREFIX = "AnaLM:";

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The note for a scan's analyst layer status, or for a check that ran no
 * scan. An absent status is read as a scan that reported no analyst output.
 */
export function analystLayerNote(
  status: AnalystLayerStatus | NoScanReason | undefined,
): string {
  if (status === "no-scan") {
    return `${PREFIX} the analyst layer did not run: --no-scan skips the local scan it runs in.`;
  }
  if (status === "registry-library") {
    return `${PREFIX} the analyst layer did not run: the registry lists this package as a library, so no local scan ran.`;
  }
  if (status === undefined || !status.ran) {
    const reason = status?.reason ?? "no-analyst-output";
    if (reason === "flag-rejected") {
      return `${PREFIX} the analyst layer did not run: the installed hackmyagent does not accept --analm.`;
    }
    if (reason === "static-only") {
      return `${PREFIX} the analyst layer did not run: --no-deep turns off the scanner's semantic layer, which the analyst runs inside.`;
    }
    return `${PREFIX} the analyst layer did not run; the scanner runs it only when a NanoMind analyst daemon answers on this machine. Set one up: npx hackmyagent nanomind setup`;
  }
  const { findingsAnalyzed, sweep } = status;
  if (findingsAnalyzed === 0 && sweep && sweep.swept > 0 && sweep.nullVerdicts === sweep.swept) {
    return `${PREFIX} the analyst daemon answered but returned no verdict for the ${count(sweep.swept, "file")} it was sent; check the daemon's logs.`;
  }
  const parts = [`${count(findingsAnalyzed, "finding")} analyzed`];
  if (sweep) {
    parts.push(`${count(sweep.swept, "file")} checked`);
    if (sweep.nullVerdicts > 0) parts.push(`${sweep.nullVerdicts} without a verdict`);
  }
  return `${PREFIX} the analyst layer ran (${parts.join(", ")}).`;
}
