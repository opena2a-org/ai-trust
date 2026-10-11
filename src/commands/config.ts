/**
 * ai-trust config - Read and change persisted settings.
 *
 * `config contribute on|off|status` controls whether scan results are shared
 * with the OpenA2A Registry. The choice is stored in ~/.opena2a/config.json,
 * the same file opena2a-cli (`opena2a config contribute on|off`) and
 * hackmyagent read, so a change here applies to all three tools.
 */

import type { Command } from "commander";
import {
  isContributeEnabled,
  saveContributeChoice,
} from "../telemetry/index.js";

const CONTRIBUTE_ACTIONS = ["on", "off", "status"] as const;
type ContributeAction = (typeof CONTRIBUTE_ACTIONS)[number];

function isContributeAction(value: string): value is ContributeAction {
  return (CONTRIBUTE_ACTIONS as readonly string[]).includes(value);
}

function describeChoice(choice: boolean | undefined): string {
  if (choice === true) return "enabled";
  if (choice === false) return "disabled";
  return "not set (scan results are not shared)";
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Read and change ai-trust settings");

  config
    .command("contribute [action]")
    .description(
      "Share scan results with the OpenA2A Registry: on | off | status (default: status)"
    )
    .action((action: string | undefined) => {
      const globalOpts = program.opts() as { json?: boolean };
      const requested = (action ?? "status").toLowerCase();

      if (!isContributeAction(requested)) {
        console.error(`Unknown action "${action}". Use: ai-trust config contribute on | off | status`);
        process.exitCode = 1;
        return;
      }

      if (requested !== "status") {
        saveContributeChoice(requested === "on");
      }

      const choice = isContributeEnabled();
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
        console.log(`Community contribution: ${describeChoice(choice)}`);
        console.log(
          choice === true
            ? "Disable: ai-trust config contribute off"
            : "Enable: ai-trust config contribute on"
        );
      }
    });
}
