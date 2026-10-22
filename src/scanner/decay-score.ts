/**
 * The score ai-trust computes from a scan's failed findings. scanPackage
 * recomputes a downloaded package's score with it once the local-setup
 * checks are left out, and a scan report's Path forward line projects with
 * it the score once the critical and high findings are fixed.
 *
 * Each failed finding weighs its severity; the score is
 * round(100 * exp(-sum / 150)), and 100 when nothing failed. The scanner's
 * own formula also weighs some findings below their severity, so a score
 * the scanner reports need not be the one this gives for its findings.
 */

const SEVERITY_WEIGHTS: Readonly<Record<string, number>> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};
/** The weight of a severity outside the four above. */
const OTHER_SEVERITY_WEIGHT = 8;
const DECAY_CONSTANT = 150;

/** The parts of a finding the score reads. */
export interface DecayScoredFinding {
  severity: string;
  passed: boolean;
}

/** The weight of the failed findings; passed findings weigh nothing. */
export function decayWeightedSum(findings: readonly DecayScoredFinding[]): number {
  let weightedSum = 0;
  for (const f of findings) {
    if (!f.passed) {
      weightedSum += SEVERITY_WEIGHTS[f.severity] ?? OTHER_SEVERITY_WEIGHT;
    }
  }
  return weightedSum;
}

/** The score, 0 to 100, for a weighted sum. */
export function scoreForWeightedSum(weightedSum: number): number {
  return weightedSum === 0 ? 100 : Math.round(100 * Math.exp(-weightedSum / DECAY_CONSTANT));
}

/** The score for these findings. */
export function decayScore(findings: readonly DecayScoredFinding[]): number {
  return scoreForWeightedSum(decayWeightedSum(findings));
}
