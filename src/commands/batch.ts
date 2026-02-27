/**
 * oa2a batch - Batch trust lookup for multiple packages.
 */

import type { Command } from "commander";
import { RegistryClient } from "../api/client.js";
import type { PackageQuery } from "../api/client.js";
import { formatBatchResults, formatJson } from "../output/formatter.js";

export function registerBatchCommand(program: Command): void {
  program
    .command("batch <names...>")
    .description("Batch trust lookup for multiple packages")
    .option("-t, --type <type>", "package type to apply to all packages")
    .option(
      "--min-trust <level>",
      "minimum trust level threshold",
      "3"
    )
    .action(
      async (
        names: string[],
        opts: { type?: string; minTrust: string }
      ) => {
        const globalOpts = program.opts() as {
          registryUrl: string;
          json: boolean;
        };

        const minTrust = parseInt(opts.minTrust, 10);
        if (isNaN(minTrust) || minTrust < 0 || minTrust > 4) {
          console.error(
            "Error: --min-trust must be a number between 0 and 4"
          );
          process.exitCode = 1;
          return;
        }

        if (names.length > 100) {
          console.error(
            `Error: Too many packages (${names.length}). The batch API supports a maximum of 100 packages per request.`
          );
          process.exitCode = 1;
          return;
        }

        const packages: PackageQuery[] = names.map((name) => ({
          name,
          ...(opts.type ? { type: opts.type } : {}),
        }));

        const client = new RegistryClient(globalOpts.registryUrl);

        try {
          const response = await client.batchQuery(packages);

          if (globalOpts.json) {
            console.log(formatJson(response));
          } else {
            console.log(formatBatchResults(response, minTrust));
          }

          // Exit code 1 if any package is below threshold
          const belowThreshold = response.results.some(
            (r) => r.found && r.trustLevel < minTrust
          );
          if (belowThreshold) {
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
          process.exitCode = 1;
        }
      }
    );
}
