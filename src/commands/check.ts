/**
 * oa2a check - Single package trust lookup.
 */

import type { Command } from "commander";
import { RegistryClient } from "../api/client.js";
import { formatCheckResult, formatJson } from "../output/formatter.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check <name>")
    .description("Look up trust information for a single package")
    .option("-t, --type <type>", "package type filter (mcp_server, a2a_agent, ai_tool, etc.). Note: the registry returns the canonical type; this flag filters but does not override the stored type.")
    .action(async (name: string, opts: { type?: string }) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      const client = new RegistryClient(globalOpts.registryUrl);

      try {
        const result = await client.checkTrust(name, opts.type);

        if (globalOpts.json) {
          console.log(formatJson(result));
        } else {
          console.log(formatCheckResult(result));
        }

        // Exit code 1 if blocked or warning
        if (result.found && (result.verdict === "blocked" || result.verdict === "warning")) {
          process.exitCode = 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exitCode = 1;
      }
    });
}
