/**
 * Commands the registry sends, in the form ai-trust cites them.
 *
 * A narrative's next steps and a detected secret's rotation command are
 * written by the registry for the users of every OpenA2A CLI. They can name
 * another CLI the way that CLI names itself (`hackmyagent check mcp:x`) or
 * through npx under its command name (`npx opena2a review`; npm has no
 * package named opena2a, the CLI's package is opena2a-cli). A global install
 * of ai-trust puts only `ai-trust` on PATH, so ai-trust prints such a command
 * as `npx <package> <arguments>`, the form scripts/foreign-voice.mjs expects.
 *
 * Only the program of a command is rewritten: the start of the command, or
 * the start of one after `;`, `&&`, `||` or `|`. Arguments are kept as sent.
 * `--json` output carries the registry's strings as sent (see sanitize.ts).
 *
 * The scanner's fix text names the same CLIs the same way, inside prose
 * (`opena2a protect . — migrates hardcoded secrets ...`). citeCommandsInText
 * finds each such command in a text and rewrites it with citeRegistryCommand.
 */
import type { CheckRichBlockInput } from "@opena2a/cli-ui";

/** The other OpenA2A CLIs: the command each installs, and its npm package. */
const PACKAGE_OF: ReadonlyMap<string, string> = new Map([
  ["hackmyagent", "hackmyagent"],
  ["opena2a", "opena2a-cli"],
  ["secretless-ai", "secretless-ai"],
]);

const OTHER_CLI_PROGRAM =
  /(^|;|&&|\|\||\|)(\s*)(?:npx(\s+(?:-y|--yes))?\s+)?(hackmyagent|opena2a|secretless-ai)(?=\s|$|;|&|\|)/g;

/** `command` with each other-CLI program written as `npx <package>`. */
export function citeRegistryCommand(command: string): string {
  return command.replace(
    OTHER_CLI_PROGRAM,
    (_match, separator: string, space: string, yes: string | undefined, bin: string) =>
      `${separator}${space}npx${yes ?? ""} ${PACKAGE_OF.get(bin)}`,
  );
}

// Words that make a name the subject of a sentence rather than a command,
// as scripts/foreign-voice.mjs lists them.
const SENTENCE_WORDS: ReadonlySet<string> = new Set([
  "a", "also", "an", "and", "are", "as", "at", "by", "can", "cli", "does",
  "for", "from", "has", "in", "is", "itself", "not", "of", "on", "or",
  "reads", "runs", "the", "to", "uses", "was", "will", "with", "writes",
]);

const OTHER_CLI_IN_TEXT =
  /(?<![\w./@-])(?:npx\s+(?:(?:-y|--yes)\s+)?)?(?:hackmyagent|opena2a|secretless-ai)(?![\w-])(?=[ \t]+([a-z.<-][^\s`"')]*))/g;

/**
 * `text` with each command of another OpenA2A CLI in it written as
 * `npx <package> <arguments>`. A name counts as a command when it starts a
 * word and the word after it looks like an argument (lower case, `.`, `-` or
 * `<`): `Run: hackmyagent scan-soul to generate one.` A name followed by an
 * English word (`hackmyagent is ...`) is the subject of a sentence and is
 * kept. Each command found is rewritten by citeRegistryCommand.
 */
export function citeCommandsInText(text: string): string {
  return text.replace(OTHER_CLI_IN_TEXT, (command: string, argument: string) =>
    !command.startsWith("npx") && SENTENCE_WORDS.has(argument.toLowerCase())
      ? command
      : citeRegistryCommand(command),
  );
}

/**
 * A copy of the rich-block input with the commands the registry sent (each
 * next step's command, each detected secret's rotation command) in the form
 * ai-trust cites them. Every other value is the same.
 */
export function citeRegistryCommands(input: CheckRichBlockInput): CheckRichBlockInput {
  return {
    ...input,
    hardcodedSecrets: {
      ...input.hardcodedSecrets,
      detected: input.hardcodedSecrets.detected.map((secret) =>
        secret.rotationCommand === undefined
          ? secret
          : { ...secret, rotationCommand: citeRegistryCommand(secret.rotationCommand) },
      ),
    },
    nextSteps: input.nextSteps.map((step) =>
      step.command === undefined ? step : { ...step, command: citeRegistryCommand(step.command) },
    ),
  };
}
