/**
 * Where the file a scanner finding names is, for `check --scan-path`.
 *
 * The scanner reports a finding's `file` relative to the directory it
 * scanned. Only `check --scan-path` names a directory the reader can open: a
 * downloaded package is unpacked into a temporary directory that is deleted
 * after its scan. check.ts looks each finding's file up in the directory
 * once, and the text and `--json` outputs build the same Verify command from
 * the answer.
 */

import { isAbsolute, join } from "node:path";
import { shellArg } from "../utils/shell-arg.js";

/** The path a finding's `file` names, given the directory that was scanned. */
export function findingPath(scanPath: string, file: string): string {
  return isAbsolute(file) ? file : join(scanPath, file);
}

// Characters a terminal acts on or does not show: the C0 and C1 controls,
// DEL, the line and paragraph separators, and the format characters, such as
// the bidirectional overrides. A command naming a path that holds one is not
// shown as it would run.
const DISPLAY_HAZARD = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\p{Cf}]/u;

/**
 * The command that prints the line a finding names, in the form the
 * scanner's own report prints: `sed -n '<line>p' <directory>/<file>`. There
 * is none for a finding with no line, for a file that is not in the
 * directory, and for a path holding a character the terminal would act on or
 * hide. A path that starts with `-` or `=` is written `./<path>`, so `sed`
 * does not read it as an option and zsh does not expand it.
 */
export function verifyCommand(
  scanPath: string,
  finding: { file?: string; line?: number },
  absentFiles: ReadonlySet<string>,
): string | undefined {
  const { file, line } = finding;
  if (typeof file !== "string" || file === "" || absentFiles.has(file)) return undefined;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  const path = findingPath(scanPath, file);
  if (DISPLAY_HAZARD.test(path)) return undefined;
  return `sed -n '${line}p' ${shellArg(/^[-=]/.test(path) ? `./${path}` : path)}`;
}
