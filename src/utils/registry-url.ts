/**
 * The root `--registry-url` option.
 *
 * The registry client refuses a base URL that does not parse or does not use
 * http or https by throwing a TypeError, and a command that built the client
 * with such a value ended in that TypeError and a stack trace. The value is
 * checked once, before any command's action runs (see src/index.ts).
 */

export const DEFAULT_REGISTRY_URL = "https://api.oa2a.org";

/**
 * The error message for a `--registry-url` value the registry client would
 * refuse, or undefined for an http or https URL.
 */
export function registryUrlProblem(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return problemMessage(value);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return problemMessage(value);
  }
  return undefined;
}

function problemMessage(value: string): string {
  return `--registry-url must be an http(s) URL, got ${JSON.stringify(value)}. Example: --registry-url ${DEFAULT_REGISTRY_URL}`;
}
