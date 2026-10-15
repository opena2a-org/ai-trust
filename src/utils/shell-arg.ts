/**
 * One word for a POSIX shell, for commands ai-trust prints for the user to
 * run. A value made only of ASCII letters, digits and `_@%+=:,./-` is printed
 * as it is; any other value is single-quoted, so a name taken from a registry
 * answer cannot add a second command to the line.
 */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
