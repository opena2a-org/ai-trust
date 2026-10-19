/**
 * Terminal-safe text for strings that come from the registry.
 *
 * A registry answer is remote data. Printed as received, an escape sequence
 * in a package name or advisory identifier is interpreted by the terminal,
 * and a carriage return or line feed starts a line the CLI never composed.
 * The text formatters pass registry values through this module first.
 * `--json` output does not: it carries each string as the registry sent it,
 * with the control characters written as JSON escapes (see formatJson).
 *
 * An error line, in text and in `--json`, and a suggested command print a
 * URL without its user name and password (redactUrlUserinfo,
 * urlWithoutUserinfo).
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

/**
 * Shorten text longer than `max` UTF-16 code units to at most `max`, ending
 * in "...". The cut is moved back one code unit when it would keep the high
 * half of a surrogate pair, so the kept text ends in a whole character.
 */
export function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - TRUNCATION_MARK.length;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end) + TRUNCATION_MARK;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

// The user name and password of a URL: the text after `://` up to the last
// `@` before a `/`, `?`, `#` or whitespace, which end the host.
const URL_USERINFO = /:\/\/[^\s/?#]+@/g;

/**
 * Print `://[redacted]@` in place of the user name and password of each URL
 * in the text. Node's fetch refuses a URL that carries them with an error
 * that quotes the whole URL, and the registry client passes that error on.
 * An `@` anywhere else, as in a path or an `@scope/name`, is left as it is.
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO, "://[redacted]@");
}

/**
 * A URL as a line of output or a suggested command prints it: as given when
 * it has no user name or password, otherwise its origin and path. A value
 * that does not parse as a URL, or has no origin to print, is printed as
 * `redactUrlUserinfo` leaves it.
 */
export function urlWithoutUserinfo(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return redactUrlUserinfo(value);
  }
  if (parsed.username === "" && parsed.password === "") return value;
  if (parsed.origin === "null") return redactUrlUserinfo(value);
  return `${parsed.origin}${parsed.pathname}`;
}
