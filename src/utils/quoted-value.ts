/**
 * A value a usage error names, as a JSON string the terminal shows as it is,
 * and a directory or a label as a line of text output names it.
 */

import { hasDisplayHazard } from "../output/finding-location.js";

/**
 * `text` as a JSON string, the form in which a usage error names a value it
 * refuses: an empty value is `""`, and a tab, a line break or an escape
 * character in it is written as a JSON escape. JSON.stringify escapes the C0
 * controls but leaves DEL and the C1 controls (U+007F to U+009F, among them
 * the one-character CSI U+009B), the line and paragraph separators U+2028
 * and U+2029 and the format characters, such as U+200B ZERO WIDTH SPACE and
 * U+202E RIGHT-TO-LEFT OVERRIDE, as they are. Those are the other characters
 * hasDisplayHazard names, and each is written here as `\u` escapes, which
 * JSON reads back as that character.
 */
export function quotedValue(text: string): string {
  let quoted = "";
  for (const char of JSON.stringify(text)) {
    quoted += hasDisplayHazard(char) ? unicodeEscapes(char) : char;
  }
  return quoted;
}

/**
 * A directory or a label as a line of text output names it: as given, or,
 * when it holds a character the terminal would act on or hide, as the JSON
 * string quotedValue writes, so the line shows each such character as an
 * escape: `/tmp/ctl<ESC>dir` is named `"/tmp/ctl\u001bdir"`.
 */
export function shownName(name: string): string {
  return hasDisplayHazard(name) ? quotedValue(name) : name;
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
