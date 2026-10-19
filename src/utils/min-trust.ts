/**
 * The `--min-trust <level>` value of `audit` and `batch`: a trust level, one
 * of the whole numbers 0 to 4.
 */

/** The refusal of a value that is not a number, or a number outside 0-4. */
export const MIN_TRUST_RANGE_PROBLEM = "--min-trust must be a number between 0 and 4";

/**
 * The trust level a `--min-trust` value names, or the usage error to print.
 * Only decimal digits name a level: `2.5` or `2abc` is refused rather than
 * read as 2, since a trust level has no fractions.
 */
export function parseMinTrust(value: string): { level: number } | { problem: string } {
  const text = value.trim();
  if (/^[+-]?\d+$/.test(text)) {
    const level = Number(text);
    return level >= 0 && level <= 4 ? { level } : { problem: MIN_TRUST_RANGE_PROBLEM };
  }
  // A number that is not a whole one, such as 2.5 or 1e0, says which value
  // was refused; any other text is not a number at all.
  if (text !== "" && Number.isFinite(Number(text))) {
    return { problem: `--min-trust must be a whole number between 0 and 4, not ${text}` };
  }
  return { problem: MIN_TRUST_RANGE_PROBLEM };
}
