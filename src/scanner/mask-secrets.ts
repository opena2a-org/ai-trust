/**
 * Masking for credential values in the text of a scanner finding.
 *
 * A finding's text can quote the scanned files. hackmyagent 0.33.2 puts the
 * matched text of its `AST-CRED-001` "Credential Harvesting Pattern" finding
 * in the message, a key in that text included, while its `AST-CRED-003`
 * finding prints the key it reports masked. When the scanner's report is
 * parsed (see `parseHmaOutput`), the name, description, message and fix of
 * every finding and every string in the result of an analyst finding pass
 * through `maskSecrets`, and so does the error of a scan that gives no report
 * (`HmaScanError`), so the text output and `--json` print the masked form.
 */

/**
 * The credential shapes that are masked: a head that names the kind of
 * credential, and the body that must follow it. The vendor shapes are the
 * vendor-prefix shapes of hackmyagent 0.33.2, with the more specific heads
 * first; the last shape is a JWT.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [head: string, body: string]> = [
  ["sk-ant-api[0-9]", "[A-Za-z0-9_-]{16,}"],
  ["sk-proj-", "[A-Za-z0-9_-]{16,}"],
  ["sk-", "[A-Za-z0-9_-]{20,}"],
  ["sk_live_", "[A-Za-z0-9]{20,}"],
  ["sk_test_", "[A-Za-z0-9]{20,}"],
  ["ghp_", "[A-Za-z0-9]{20,}"],
  ["gho_", "[A-Za-z0-9]{20,}"],
  ["ghs_", "[A-Za-z0-9]{20,}"],
  ["ghu_", "[A-Za-z0-9]{20,}"],
  ["github_pat_", "[A-Za-z0-9_]{20,}"],
  ["hf_", "[A-Za-z0-9]{20,}"],
  ["glpat-", "[A-Za-z0-9_-]{20,}"],
  ["npm_", "[A-Za-z0-9]{20,}"],
  ["AKIA", "[0-9A-Z]{16}"],
  ["AIza", "[0-9A-Za-z_-]{35}"],
  ["xox[abprs]-", "[0-9A-Za-z-]{10,}"],
  ["SG\\.", "[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}"],
  // Header, then two or more dot-separated base64url segments. Only an `eyJ`
  // that begins a run of base64url characters is read as a header (`_` and
  // `-` before it are refused as well): a header read from each `eyJ` in a
  // run would scan the rest of the run again from each one.
  ["(?<![_-])eyJ", "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+){2,}"],
];

/**
 * One pattern for every shape, each head in a capture group of its own. A
 * head preceded by a letter or digit is not one (`task-` holds no `sk-`
 * head). The run of `A-Z a-z 0-9 _ -` characters that goes on after the body
 * is matched with it, so a token joined to more token text is masked whole.
 */
const CREDENTIAL_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(?:${CREDENTIAL_SHAPES.map(([head, body]) => `(${head})${body}`).join("|")})[A-Za-z0-9_-]*`,
  "g",
);

/**
 * A value with no head, as hackmyagent 0.33.2 reads one: a run of 40 or more
 * `A-Z a-z 0-9 + = _` characters between word boundaries. The scanner reads
 * such a run as a credential when a window of 40 of its characters is not
 * filler (see `hasCredibleWindow`), and so it is masked then.
 */
const HEADLESS_PATTERN = /\b[A-Za-z0-9+=_]{40,}\b/g;

/** The width of the window a run with no head is judged in. */
const WINDOW_LENGTH = 40;

/** A window that repeats a unit of at most this many characters is filler. */
const MAX_FILLER_UNIT = 4;

/** A window with one character in more than this many places (90%) is filler. */
const MAX_DOMINANT_COUNT = 36;

/** The most `*` characters a masked body is printed as. */
const MAX_MASK_LENGTH = 16;

/**
 * True when some window of 40 characters of `run` is not filler: it repeats
 * no unit of 4 or fewer characters (`_`, `_=` or `FAKE` over and over), and
 * no character takes more than 36 of its places. These are the rules by
 * which hackmyagent 0.33.2 tells a value from filler. One pass over `run`:
 * the window's character counts, and for each unit length the places that
 * break that unit, are updated as the window moves.
 */
function hasCredibleWindow(run: string): boolean {
  // `run` holds only characters of HEADLESS_PATTERN, all below 128.
  const counts = new Uint8Array(128);
  let dominant = 0;
  // breaks[u]: the places i of the window, from its u-th on, where the
  // character differs from the one u places before it. The window repeats a
  // unit of u characters when there are none.
  const breaks = new Array<number>(MAX_FILLER_UNIT + 1).fill(0);
  const at = (i: number) => run.charCodeAt(i);
  const repeatsAUnit = () => breaks.some((count, unit) => unit > 0 && count === 0);

  for (let i = 0; i < WINDOW_LENGTH; i++) {
    if (++counts[at(i)] === MAX_DOMINANT_COUNT + 1) dominant++;
    for (let unit = 1; unit <= Math.min(MAX_FILLER_UNIT, i); unit++) {
      if (at(i) !== at(i - unit)) breaks[unit]++;
    }
  }
  for (let start = 0; ; start++) {
    if (dominant === 0 && !repeatsAUnit()) return true;
    const end = start + WINDOW_LENGTH;
    if (end >= run.length) return false;
    // The window moves one place: `start` leaves it and `end` joins it.
    if (counts[at(start)]-- === MAX_DOMINANT_COUNT + 1) dominant--;
    if (++counts[at(end)] === MAX_DOMINANT_COUNT + 1) dominant++;
    for (let unit = 1; unit <= MAX_FILLER_UNIT; unit++) {
      if (at(start + unit) !== at(start)) breaks[unit]--;
      if (at(end) !== at(end - unit)) breaks[unit]++;
    }
  }
}

/**
 * Replace each credential-shaped value in `text` with its head and one `*`
 * for each character after the head, at most 16: a 43-character body after
 * `sk-` is printed `sk-****************`, the form in which `AST-CRED-003`
 * prints a key. A value with no head is printed as one `*` for each of its
 * characters, at most 16.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(CREDENTIAL_PATTERN, (match: string, ...groups: unknown[]) => {
      const head =
        groups
          .slice(0, CREDENTIAL_SHAPES.length)
          .find((group): group is string => typeof group === "string") ?? "";
      return head + "*".repeat(Math.min(match.length - head.length, MAX_MASK_LENGTH));
    })
    .replace(HEADLESS_PATTERN, (run: string) =>
      hasCredibleWindow(run) ? "*".repeat(Math.min(run.length, MAX_MASK_LENGTH)) : run,
    );
}

/**
 * `value` with `maskSecrets` applied to it when it is a string, and to every
 * string in it, at any depth, when it is an array or an object; any other
 * value is returned as it is. An array or object is changed in place: it is
 * one the scanner's report was parsed into.
 */
export function maskSecretsIn<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  const pending: unknown[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== "object" || next === null) continue;
    const container = next as Record<string, unknown>;
    // Each key is the container's own, so assigning to it, `__proto__`
    // included, sets that key.
    for (const key of Object.keys(container)) {
      const item = container[key];
      if (typeof item === "string") container[key] = maskSecrets(item);
      else if (typeof item === "object" && item !== null) pending.push(item);
    }
  }
  return value;
}
