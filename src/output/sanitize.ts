/**
 * Terminal-safe text for strings that come from the registry.
 *
 * A registry answer is remote data. Printed as received, an escape sequence
 * in a package name or advisory identifier is interpreted by the terminal,
 * and a carriage return or line feed starts a line the CLI never composed.
 * The text formatters pass registry values through this module first.
 * `--json` output does not: it carries each string as the registry sent it,
 * with the control characters written as JSON escapes (see formatJson).
 */

// Tab, line feed, vertical tab, form feed and carriage return separate words
// in legitimate text, so a run of them becomes one space.
const LINE_AND_TAB_RUNS = /[\t\n\v\f\r]+/g;

// The remaining C0 controls (U+0000 to U+001F, which include ESC and BEL),
// DEL, and the C1 controls (U+0080 to U+009F, which include the one-character
// forms of CSI and OSC).
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const TRUNCATION_MARK = "...";

/** Remove control characters from one registry string. */
export function stripControlCharacters(text: string): string {
  return text.replace(LINE_AND_TAB_RUNS, " ").replace(CONTROL_CHARACTERS, "");
}

/**
 * Copy a registry value with control characters removed from the strings in
 * it, nested objects and arrays included. Numbers, booleans and null are
 * returned as they are.
 */
export function sanitizeRegistryValue<T>(value: T): T {
  if (typeof value === "string") return stripControlCharacters(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRegistryValue(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeRegistryValue(entry)]),
    ) as T;
  }
  return value;
}

/** Shorten text longer than `max` characters to `max`, ending in "...". */
export function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}
