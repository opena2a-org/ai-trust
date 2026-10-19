/**
 * ai-trust config - Read and change persisted settings.
 *
 * `config contribute on|off|status` controls whether scan results are shared
 * with the OpenA2A Registry. The choice is stored in ~/.opena2a/config.json,
 * the same file opena2a-cli (`opena2a config contribute on|off`) and
 * hackmyagent read, so a change here applies to all three tools.
 */

import type { Command } from "commander";
import { stripControlCharacters } from "../output/sanitize.js";
import {
  hasUnmarkedOff,
  readContributeChoice,
  saveContributeChoice,
} from "../telemetry/index.js";
// The root --help states the saved choice in the same words.
import { describeContributeChoice } from "../utils/help-footer.js";

const CONTRIBUTE_ACTIONS = ["on", "off", "status"] as const;
type ContributeAction = (typeof CONTRIBUTE_ACTIONS)[number];

function isContributeAction(value: string): value is ContributeAction {
  return (CONTRIBUTE_ACTIONS as readonly string[]).includes(value);
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Read and change ai-trust settings")
    // Commander adds `config help` only to a command without an action.
    .helpCommand(true)
    .action((_opts: unknown, cmd: Command) => {
      // Bare `config`, like bare `ai-trust`, prints its help to stdout and
      // exits 0; without an action Commander prints it as an error (exit 1).
      if (cmd.args.length === 0) cmd.help();
      // A word that is not a subcommand stays Commander's own error, with its
      // "Did you mean" suggestion.
      (cmd as Command & { unknownCommand(): never }).unknownCommand();
    });

  config
    .command("contribute [action]")
    .description(
      "Share scan results with the OpenA2A Registry: on | off | status (default: status)"
    )
    .action((action: string | undefined) => {
      const globalOpts = program.opts() as { json?: boolean };
      const requested = (action ?? "status").toLowerCase();

      // Worded as `telemetry` words its own; with --json the `error` of one
      // object on stdout, as for the other usage errors.
      if (!isContributeAction(requested)) {
        const problem = `Unknown action '${action}'. Use: ai-trust config contribute on | off | status`;
        if (globalOpts.json) {
          console.log(JSON.stringify({ error: problem }, null, 2));
        } else {
          console.error(`Error: ${stripControlCharacters(problem)}`);
        }
        process.exitCode = 1;
        return;
      }

      if (requested !== "status") {
        saveContributeChoice(requested === "on");
      }

      const choice = readContributeChoice();
      if (globalOpts.json) {
        console.log(JSON.stringify({ contribute: choice ?? null }, null, 2));
        return;
      }

      if (requested === "on") {
        console.log("Community contribution enabled for ai-trust, hackmyagent and opena2a-cli.");
        console.log("Disable: ai-trust config contribute off");
      } else if (requested === "off") {
        console.log("Community contribution disabled for ai-trust, hackmyagent and opena2a-cli.");
        console.log("Enable: ai-trust config contribute on");
      } else {
        console.log(`Community contribution: ${describeContributeChoice(choice)}`);
        console.log(
          choice === true
            ? "Disable: ai-trust config contribute off"
            : "Enable: ai-trust config contribute on"
        );
        if (choice === undefined && hasUnmarkedOff()) {
          console.log("Answered no in an earlier ai-trust version? Record it: ai-trust config contribute off");
        }
      }
    });
}
