/**
 * oa2a audit - Parse dependency files and batch query trust.
 */

import type { Command } from "commander";
import { RegistryClient } from "../api/client.js";
import { parseDependencyFile } from "../utils/parser.js";
import { formatBatchResults, formatJson } from "../output/formatter.js";

export function registerAuditCommand(program: Command): void {
  program
    .command("audit <file>")
    .description(
      "Audit dependencies from package.json or requirements.txt"
    )
    .option(
      "--min-trust <level>",
      "minimum trust level threshold",
      "3"
    )
    .action(async (file: string, opts: { minTrust: string }) => {
      const globalOpts = program.opts() as {
        registryUrl: string;
        json: boolean;
      };

      const minTrust = parseInt(opts.minTrust, 10);
      if (isNaN(minTrust) || minTrust < 0 || minTrust > 4) {
        console.error("Error: --min-trust must be a number between 0 and 4");
        process.exitCode = 1;
        return;
      }

      try {
        const packages = await parseDependencyFile(file);

        if (packages.length === 0) {
          console.log("No dependencies found in the specified file.");
          return;
        }

        if (packages.length > 100) {
          console.error(
            `Error: Too many dependencies (${packages.length}). The batch API supports a maximum of 100 packages per request.`
          );
          process.exitCode = 1;
          return;
        }

        const client = new RegistryClient(globalOpts.registryUrl);
        const response = await client.batchQuery(packages);

        if (globalOpts.json) {
          console.log(formatJson(response));
        } else {
          console.log(formatBatchResults(response, minTrust));
        }

        // Exit code 2 for policy violation (below threshold).
        // Exit code 1 is reserved for actual errors (network, server).
        const belowThreshold = response.results.some(
          (r) => r.found && r.trustLevel < minTrust
        );
        if (belowThreshold) {
          process.exitCode = 2;
        }
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          console.error(`Error: File not found: ${file}`);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}
