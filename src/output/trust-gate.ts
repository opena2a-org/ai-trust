/**
 * The trust gate of `audit` and `batch`: the dependencies that make the
 * command exit 2. The exit code and the Summary of the text output are both
 * read from it, so the text cannot say the dependencies pass while the
 * command fails.
 */

import type { TrustAnswer } from "@opena2a/registry-client";
import { sanitizeRegistryValue } from "./sanitize.js";

export interface TrustGate {
  /** True when no dependency fails the gate: the command exits 0. */
  passed: boolean;
  /** Dependencies the registry does not have and no local scan found. */
  notFound: TrustAnswer[];
  /** Dependencies found below the minimum trust level. */
  belowThreshold: TrustAnswer[];
}

/**
 * The dependencies of a batch answer that fail the gate, of every tier: a
 * library below `--min-trust` fails it too, as `check` exits 2 for a library
 * the registry flags as blocked or warning. The answers are read after their
 * control characters are removed, as the text output reads them.
 */
export function trustGate(results: readonly TrustAnswer[], minTrust: number): TrustGate {
  const answers = sanitizeRegistryValue([...results]);
  const notFound = answers.filter((r) => !r.found);
  const belowThreshold = answers.filter((r) => r.found && r.trustLevel < minTrust);
  return {
    passed: notFound.length === 0 && belowThreshold.length === 0,
    notFound,
    belowThreshold,
  };
}
