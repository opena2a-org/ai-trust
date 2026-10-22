/**
 * The `--min-trust <level>` value of `audit` and `batch`: a trust level, one
 * of the whole numbers 0 to 4.
 */

import { Option } from "commander";

/** The level `--min-trust` has when it is not given: 2, Listed. */
const DEFAULT_MIN_TRUST = "2";

/**
 * The `--min-trust <level>` option of `audit` and `batch`. Its default is the
 * text parseMinTrust reads, and the help names it as the level it is,
 * `(default: 2)`, where Commander would print the text as `(default: "2")`.
 */
export function minTrustOption(): Option {
  return new Option("--min-trust <level>", "minimum trust level threshold (0-4)").default(
    DEFAULT_MIN_TRUST,
    DEFAULT_MIN_TRUST,
  );
}

/**
 * The trust level a `--min-trust` value names, or the usage error to print.
 * Only decimal digits name a level: `2.5` or `2abc` is refused rather than
 * read as 2, since a trust level has no fractions. Whitespace around the
 * digits is dropped before they are read, so ` 3 ` is level 3. Every value
 * refused gets the same usage error, which names the value as given, with
 * the whitespace around it: ` 9` is named as `" 9"`, not as `9`.
 */
export function parseMinTrust(value: string): { level: number } | { problem: string } {
  const text = value.trim();
  if (/^[+-]?\d+$/.test(text)) {
    const level = Number(text);
    if (level >= 0 && level <= 4) return { level };
  }
  return { problem: `--min-trust must be a whole number between 0 and 4, not ${shownValue(value)}` };
}

/** DEL and the C1 controls, which JSON.stringify writes as they are. */
const DEL_AND_C1_CONTROLS = /[\u007f-\u009f]/g;

/**
 * A refused value as the usage error names it: as given when it is printable
 * ASCII without spaces, such as `2.5` or `abc`, otherwise as a JSON string,
 * which shows an empty value as `""` and writes a tab, a line break or an
 * escape character in it as a JSON escape. JSON.stringify leaves DEL and the
 * C1 controls (U+007F to U+009F, among them the one-character CSI U+009B) as
 * they are, so those are written as `\u007f` to `\u009f` escapes here.
 */
function shownValue(text: string): string {
  if (/^[!-~]+$/.test(text)) return text;
  return JSON.stringify(text).replace(
    DEL_AND_C1_CONTROLS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
