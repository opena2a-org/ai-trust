/**
 * Where the file a scanner finding names is, for `check --scan-path`, and the
 * commands that act on the directory it scanned.
 *
 * The scanner reports a finding's `file` relative to the directory it
 * scanned. Only `check --scan-path` names a directory the reader can open: a
 * downloaded package is unpacked into a temporary directory that is deleted
 * after its scan. check.ts looks each finding's file up in the directory
 * once, and the text and `--json` outputs build the same Verify command from
 * the answer, and the same Fix command from the scanner's fix.
 */

import { isAbsolute, join } from "node:path";
import { shellArg } from "../utils/shell-arg.js";
import { citeCommandsInText } from "./registry-command.js";

/** The path a finding's `file` names, given the directory that was scanned. */
export function findingPath(scanPath: string, file: string): string {
  return isAbsolute(file) ? file : join(scanPath, file);
}

/**
 * `path` as one shell word that a command reads as an operand. A path that
 * starts with `-` or `=` is written `./<path>`, so the command does not read
 * it as an option and zsh does not expand it.
 */
export function pathArg(path: string): string {
  return shellArg(/^[-=]/.test(path) ? `./${path}` : path);
}

/** The scanner's remediation command. It names no directory, so it acts on the one it runs in. */
const SECURE_FIX = "npx hackmyagent secure --fix";

/**
 * The command that applies the scanner's fixes to `scanPath`, the directory
 * `check --scan-path` scanned, as the user gave it:
 * `npx hackmyagent secure <directory> --fix`. With no directory it is
 * `npx hackmyagent secure --fix`, which acts on the current directory.
 */
export function secureFixCommand(scanPath?: string): string {
  return scanPath === undefined ? SECURE_FIX : `npx hackmyagent secure ${pathArg(scanPath)} --fix`;
}

/**
 * A finding's fix as ai-trust prints it. The scanner's fix text names each
 * OpenA2A CLI by its command (`hackmyagent secure --fix`, `opena2a protect
 * .`). A global install of ai-trust puts none of them on PATH, so each is
 * written in the `npx <package> ...` form the Verdict and Next Steps lines
 * use (`npx opena2a-cli protect .`). A fix that is only `secure --fix` would
 * act on the directory it runs in, so after `check --scan-path` it names
 * `scanPath`, the directory scanned. Any other text is kept as the scanner
 * wrote it.
 */
export function runnableFix(fix: string, scanPath?: string): string {
  const cited = citeCommandsInText(fix);
  return scanPath !== undefined && cited.trim() === SECURE_FIX ? secureFixCommand(scanPath) : cited;
}

// Characters a terminal acts on or does not show: the C0 and C1 controls,
// DEL, the line and paragraph separators, and the format characters, such as
// the bidirectional overrides. A command naming a path that holds one is not
// shown as it would run.
const DISPLAY_HAZARD = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\p{Cf}]/u;

/**
 * True when `path` holds a character the terminal would act on or hide. A
 * command naming such a path is not shown as it would run: printed as it is,
 * the line does not show the command that runs, and with the character
 * removed, the command names another path. The Verify commands, and the fix
 * and audit commands of the text output, are left out for such a path.
 */
export function hasDisplayHazard(path: string): boolean {
  return DISPLAY_HAZARD.test(path);
}

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
  if (hasDisplayHazard(path)) return undefined;
  return `sed -n '${line}p' ${pathArg(path)}`;
}
