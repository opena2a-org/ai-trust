/**
 * The `--min-trust <level>` value of `audit` and `batch`: a trust level, one
 * of the whole numbers 0 to 4.
 */

import { Option } from "commander";
import { hasDisplayHazard } from "../output/finding-location.js";

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

/**
 * A refused value as the usage error names it: as given when it is printable
 * ASCII without spaces, such as `2.5` or `abc`, otherwise as a JSON string,
 * which shows an empty value as `""` and writes a tab, a line break or an
 * escape character in it as a JSON escape. JSON.stringify escapes the C0
 * controls but leaves DEL, the C1 controls (U+007F to U+009F, among them the
 * one-character CSI U+009B), the line and paragraph separators U+2028 and
 * U+2029 and the format characters, such as U+200B ZERO WIDTH SPACE and
 * U+202E RIGHT-TO-LEFT OVERRIDE, as they are. Those are the other characters
 * hasDisplayHazard names, and each is written here as `\u` escapes, which
 * JSON reads back as that character.
 */
function shownValue(text: string): string {
  if (/^[!-~]+$/.test(text)) return text;
  let shown = "";
  for (const char of JSON.stringify(text)) {
    shown += hasDisplayHazard(char) ? unicodeEscapes(char) : char;
  }
  return shown;
}

/**
 * `char` as `\u` escapes, one for each of its UTF-16 code units: one for
 * U+200B, and for a character above U+FFFF, such as U+E0041, the two of its
 * surrogate pair.
 */
function unicodeEscapes(char: string): string {
  let escapes = "";
  for (let i = 0; i < char.length; i++) {
    escapes += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return escapes;
}
