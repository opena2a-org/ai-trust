/**
 * The root `--registry-url` option.
 *
 * The registry client refuses a base URL that does not parse or does not use
 * http or https by throwing a TypeError, and a command that built the client
 * with such a value ended in that TypeError and a stack trace. The value is
 * checked once, before any command's action runs (see src/index.ts).
 *
 * A URL with user:password@ is refused there too: the request could not be
 * built from it, and the error that said so quoted the URL, password
 * included.
 */

export const DEFAULT_REGISTRY_URL = "https://api.oa2a.org";

export const CREDENTIALS_PROBLEM =
  `--registry-url must not include credentials (user:password@). ai-trust sends no credentials to the registry; pass the URL without them. Example: --registry-url ${DEFAULT_REGISTRY_URL}`;

/**
 * The error message for a `--registry-url` value the registry client would
 * refuse, or undefined for an http or https URL without credentials.
 */
export function registryUrlProblem(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return problemMessage(value);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return CREDENTIALS_PROBLEM;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return problemMessage(value);
  }
  return undefined;
}

/**
 * The value with the userinfo (everything from `//` up to the last `@` of the
 * authority) removed, so an error line that quotes a value that does not
 * parse does not print a password in it.
 */
export function withoutUserinfo(value: string): string {
  return value.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#]*@/i, "$1");
}

function problemMessage(value: string): string {
  return `--registry-url must be an http(s) URL, got ${JSON.stringify(withoutUserinfo(value))}. Example: --registry-url ${DEFAULT_REGISTRY_URL}`;
}
