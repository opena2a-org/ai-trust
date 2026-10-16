/**
 * The dependency file `ai-trust audit` can read in a directory.
 *
 * A printed `ai-trust audit <file>` next step has to run where the user
 * stands, so it is shown only when that file exists there. This is an
 * existence check of two fixed names: it reads nothing, parses nothing and
 * never looks in a parent directory.
 *
 * The file names `audit` accepts are decided here too, so the parser, the
 * ecosystem it reports and the refusal agree.
 */

import { statSync } from "node:fs";
import { basename, join } from "node:path";

/** The file names `audit` reads, in the order a next step prefers them. */
export const AUDIT_FILES = ["package.json", "requirements.txt"] as const;

export type AuditFile = (typeof AUDIT_FILES)[number];

/**
 * Whether a file of this base name is a requirements file: requirements.txt,
 * a variant such as requirements-dev.txt, or a bare `requirements`.
 */
export function isRequirementsFileName(name: string): boolean {
  return name === "requirements" || /^requirements.*\.txt$/.test(name);
}

/** Whether `audit` reads a file of this base name. */
export function isAuditFileName(name: string): boolean {
  return name === "package.json" || isRequirementsFileName(name);
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
  const name = basename(path);
  if (isAuditFileName(name)) return null;
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
