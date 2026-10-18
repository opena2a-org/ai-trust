/**
 * The trust gate of `audit` and `batch`: the dependencies that make the
 * command exit 2. The exit code and the Summary of the text output are both
 * read from it, so the text cannot say the dependencies pass while the
 * command fails.
 */

import type { TrustAnswer } from "@opena2a/registry-client";
import type { BatchAnswer } from "./formatter.js";
import { sanitizeRegistryValue } from "./sanitize.js";

export interface TrustGate {
  /** True when no dependency fails the gate: the command exits 0. */
  passed: boolean;
  /** Dependencies the registry does not have and no local scan found. */
  notFound: TrustAnswer[];
  /** Dependencies found below the minimum trust level. */
  belowThreshold: TrustAnswer[];
  /**
   * Dependencies `batch --type` excluded: the registry has them under
   * another type. Neither list above counts them.
   */
  excludedByType: TrustAnswer[];
}

/**
 * The dependencies of a batch answer that fail the gate, of every tier: a
 * library below `--min-trust` fails it too, as `check` exits 2 for a library
 * the registry flags as blocked or warning, and so does a package
 * `batch --type` excluded. The answers are read after their control
 * characters are removed, as the text output reads them.
 */
export function trustGate(results: readonly TrustAnswer[], minTrust: number): TrustGate {
  const answers = sanitizeRegistryValue([...results]);
  const isExcluded = (r: TrustAnswer): boolean => (r as BatchAnswer).excludedByType === true;
  const excludedByType = answers.filter(isExcluded);
  const ofType = answers.filter((r) => !isExcluded(r));
  const notFound = ofType.filter((r) => !r.found);
  const belowThreshold = ofType.filter((r) => r.found && r.trustLevel < minTrust);
  return {
    passed: notFound.length === 0 && belowThreshold.length === 0 && excludedByType.length === 0,
    notFound,
    belowThreshold,
    excludedByType,
  };
}
