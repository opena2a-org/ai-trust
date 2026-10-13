/**
 * The dependency file `ai-trust audit` can read in a directory.
 *
 * A printed `ai-trust audit <file>` next step has to run where the user
 * stands, so it is shown only when that file exists there. This is an
 * existence check of two fixed names: it reads nothing, parses nothing and
 * never looks in a parent directory.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

/** The file names `audit` reads, in the order a next step prefers them. */
export const AUDIT_FILES = ["package.json", "requirements.txt"] as const;

export type AuditFile = (typeof AUDIT_FILES)[number];

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
