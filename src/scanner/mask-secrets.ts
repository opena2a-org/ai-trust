/**
 * Masking for credential values in the text of a scanner finding.
 *
 * A finding message can quote the scanned files. hackmyagent 0.33.2 puts the
 * matched text of its `AST-CRED-001` "Credential Harvesting Pattern" finding
 * in the message, a key in that text included, while its `AST-CRED-003`
 * finding prints the key it reports masked. Every finding message passes
 * through `maskSecrets` when the scanner's report is parsed (see
 * `parseHmaOutput`), so the text output and `--json` print the masked form.
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

/** The most `*` characters a masked body is printed as. */
const MAX_MASK_LENGTH = 16;

/**
 * Replace each credential-shaped value in `text` with its head and one `*`
 * for each character after the head, at most 16: a 43-character body after
 * `sk-` is printed `sk-****************`, the form in which `AST-CRED-003`
 * prints a key.
 */
export function maskSecrets(text: string): string {
  return text.replace(CREDENTIAL_PATTERN, (match: string, ...groups: unknown[]) => {
    const head =
      groups
        .slice(0, CREDENTIAL_SHAPES.length)
        .find((group): group is string => typeof group === "string") ?? "";
    return head + "*".repeat(Math.min(match.length - head.length, MAX_MASK_LENGTH));
  });
}
