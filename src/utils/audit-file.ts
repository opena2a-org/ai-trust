/**
 * The dependency file `ai-trust audit` can read in a directory.
 *
 * A printed `ai-trust audit <file>` next step has to run where the user
 * stands, so it is shown only when that file exists there. This is an
 * existence check of two fixed names: it reads nothing, parses nothing and
 * never looks in a parent directory.
 *
 * Which files `audit` accepts is decided here too, so the parser, the
 * ecosystem it reports and the refusal agree.
 */

import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The file names `audit` reads, in the order a next step prefers them. */
export const AUDIT_FILES = ["package.json", "requirements.txt"] as const;

export type AuditFile = (typeof AUDIT_FILES)[number];

/**
 * Whether the file at `path` is a requirements file, by its name and the
 * directory it is in: a `.txt` file whose name contains `requirements`
 * (requirements.txt, requirements-dev.txt, dev-requirements.txt), a bare
 * `requirements`, or a `.txt` file in a directory named `requirements`
 * (requirements/dev.txt).
 */
export function isRequirementsFile(path: string): boolean {
  const name = basename(path);
  if (name === "requirements" || isRequirementsTxtName(name)) return true;
  return name.endsWith(".txt") && parentDirName(path) === "requirements";
}

/**
 * Whether `name` holds `requirements` and ends in `.txt` with no line break
 * between the two, the names /requirements.*\.txt$/ matches. On a name of
 * repeated `requirements` that does not end in `.txt`, that pattern takes
 * time that grows with the square of the name's length; these string
 * searches grow linearly with it.
 */
function isRequirementsTxtName(name: string): boolean {
  // The line breaks `.` does not match: LF, CR, U+2028 (Zl) and U+2029 (Zp).
  const lastLine = name.split(/[\n\r\p{Zl}\p{Zp}]/u).pop() ?? "";
  return lastLine.endsWith(".txt") && lastLine.includes("requirements");
}

/** Whether `audit` reads the file at `path`. */
export function isAuditFile(path: string): boolean {
  return basename(path) === "package.json" || isRequirementsFile(path);
}

/**
 * The name of the directory `path` is in, so `dev.txt` named from inside
 * `requirements/` counts as `requirements/dev.txt`.
 */
function parentDirName(path: string): string {
  try {
    return basename(dirname(resolve(path)));
  } catch {
    // process.cwd() throws when the working directory was removed.
    return basename(dirname(path));
  }
}

/**
 * The refusal of a file `audit` does not read: every line of any other file
 * would be taken as a package name and sent to the registry.
 */
export class NotAnAuditFileError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(`audit reads package.json or requirements.txt; ${fileName} is neither.`);
    this.name = "NotAnAuditFileError";
    this.fileName = fileName;
  }
}

/**
 * The refusal for `path` when it is a file whose name `audit` does not
 * read, otherwise null. It is decided before the file is read. A path that
 * does not exist, or is a directory, gets null: reading it reports that.
 */
export function auditFileRefusal(path: string): NotAnAuditFileError | null {
  if (isAuditFile(path)) return null;
  const name = basename(path);
  try {
    if (statSync(path).isDirectory()) return null;
  } catch {
    // Absent or unreadable: reading it reports why.
    return null;
  }
  return new NotAnAuditFileError(name);
}

/**
 * The first of `package.json` and `requirements.txt` that is a regular file
 * in `dir` (default: the current working directory), or null when neither
 * is. Any error while looking counts as absent.
 */
export function findAuditFile(dir?: string): AuditFile | null {
  try {
    const base = dir ?? process.cwd();
    for (const name of AUDIT_FILES) {
      try {
        if (statSync(join(base, name)).isFile()) return name;
      } catch {
        // Absent or unreadable: try the next name.
      }
    }
  } catch {
    // process.cwd() throws when the working directory was removed.
  }
  return null;
}
