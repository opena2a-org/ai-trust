/**
 * Foreign voice: text ai-trust prints that is written in another tool's
 * voice. One tool does not speak in another tool's voice.
 *
 * Two shapes are reported:
 *
 *   bare-command   a command of another OpenA2A CLI, cited the way that CLI
 *                  cites itself (`hackmyagent check express`), or through
 *                  npx under a name that is not the CLI's npm package
 *                  (`npx opena2a review`: the package is opena2a-cli).
 *                  ai-trust cites those CLIs as `npx <package> <arguments>`,
 *                  the form runnableFix in src/output/formatter.ts gives the
 *                  scanner's fix text, because ai-trust installs hackmyagent
 *                  as a dependency, not on PATH.
 *   self-as-other  the running tool named as a separate CLI, command, tool
 *                  or package, as a footer written for another tool's users
 *                  would say it (`ai-trust is a separate CLI`).
 *
 * A name counts as a command when it stands where a command is written: at
 * the start of a line (after an optional `$ ` prompt), after a colon or an
 * arrow, after a run of two or more spaces (a column-aligned label), after
 * an opening backtick, quote or parenthesis, or after "run". The word after
 * the name must look like an argument (lower case, `.`, `-` or `<`), and an
 * English word there ("hackmyagent is ...") means the name is the subject of
 * a sentence, not a command.
 */

/** The other OpenA2A CLIs: the command each installs, and its npm package. */
export const OTHER_CLIS = [
  { bin: "hackmyagent", pkg: "hackmyagent" },
  { bin: "opena2a", pkg: "opena2a-cli" },
  { bin: "secretless-ai", pkg: "secretless-ai" },
];

const PACKAGE_OF = new Map(OTHER_CLIS.map((c) => [c.bin, c.pkg]));

// Words that make the name the subject of a sentence rather than a command.
const SENTENCE_WORDS = new Set([
  "a", "also", "an", "and", "are", "as", "at", "by", "can", "cli", "does",
  "for", "from", "has", "in", "is", "itself", "not", "of", "on", "or",
  "reads", "runs", "the", "to", "uses", "was", "will", "with", "writes",
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CITATION = new RegExp(
  String.raw`(?<=^\s*(?:\$\s+)?|[:→]\s+|\S {2,}|[\x60"'(]|\b[Rr]un\s+)` +
    String.raw`(npx\s+(?:(?:-y|--yes)\s+)?)?` +
    `(${OTHER_CLIS.map((c) => escape(c.bin)).join("|")})(?![\\w-])` +
    String.raw`[ \t]+([a-z.<-][^\s\x60"')]*)`,
  "g",
);

/**
 * The foreign-voice lines in `text`, as
 * `{ line, rule, cited, expected?, text }`; `line` is 1-based and `text` is
 * the line, trimmed.
 *
 * @param {string} text
 * @param {{ self?: string }} [options] self: the name of the tool that prints
 *   `text` (default "ai-trust").
 */
export function foreignVoice(text, { self = "ai-trust" } = {}) {
  const selfAsOther = new RegExp(
    `(?<![\\w-])${escape(self)}(?![\\w-]) is a separate (?:CLI|command|tool|package)\\b`,
    "i",
  );
  const findings = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    for (const m of line.matchAll(CITATION)) {
      const [, npx, bin, word] = m;
      if (bin === self) continue;
      const pkg = PACKAGE_OF.get(bin);
      if (npx === undefined && SENTENCE_WORDS.has(word.toLowerCase())) continue;
      if (npx !== undefined && pkg === bin) continue;
      findings.push({
        line: i + 1,
        rule: "bare-command",
        cited: `${npx ?? ""}${bin} ${word}`,
        expected: `npx ${pkg} ${word}`,
        text: line.trim(),
      });
    }
    const other = selfAsOther.exec(line);
    if (other) {
      findings.push({ line: i + 1, rule: "self-as-other", cited: other[0], text: line.trim() });
    }
  });
  return findings;
}

/** One finding as a report line: `<where>:<line>: <rule>: ...`. */
export function describeFinding(where, f) {
  const fix = f.expected ? `; ai-trust's form is "${f.expected}"` : "";
  return `${where}:${f.line}: ${f.rule}: "${f.cited}"${fix} (${f.text})`;
}
