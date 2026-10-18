/**
 * oa2a batch - Batch trust lookup for multiple packages.
 */

import type { Command } from "commander";
import type { PackageQuery } from "@opena2a/registry-client";
import { createRegistryClient, registryFailureSentence } from "../utils/registry-client.js";
import { formatBatchResults, formatJson } from "../output/formatter.js";
import { stripControlCharacters } from "../output/sanitize.js";
import { trustGate } from "../output/trust-gate.js";
import { resolveAndLog } from "../utils/resolve.js";
import { shellArg } from "../utils/shell-arg.js";
import { createRequire } from "node:module";

const batchRequire = createRequire(import.meta.url);
const batchPkg = batchRequire("../../package.json");
const AI_TRUST_VERSION: string = batchPkg.version;

export function registerBatchCommand(program: Command): void {
  program
    .command("batch <names...>")
    .description("Batch trust lookup for multiple packages")
    .option("-t, --type <type>", "package type to apply to all packages")
    .option(
      "--min-trust <level>",
      "minimum trust level threshold (0-4)",
      "2"
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

        // With --json a usage error is the `error` of one object on stdout,
        // as for a --registry-url usage error.
        const usageError = (problem: string): void => {
          if (globalOpts.json) {
            console.log(formatJson({ error: problem }));
          } else {
            console.error(`Error: ${problem}`);
          }
          process.exitCode = 1;
        };

        const minTrust = parseInt(opts.minTrust, 10);
        if (isNaN(minTrust) || minTrust < 0 || minTrust > 4) {
          usageError("--min-trust must be a number between 0 and 4");
          return;
        }

        if (names.length > 100) {
          usageError(
            `Too many packages (${names.length}). The batch API supports a maximum of 100 packages per request.`
          );
          return;
        }

        const packages: PackageQuery[] = names.map((rawName) => ({
          name: resolveAndLog(rawName),
          ...(opts.type ? { type: opts.type } : {}),
        }));

        const client = createRegistryClient({
          baseUrl: globalOpts.registryUrl,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        });

        try {
          const response = await client.batchQuery(packages);

          // When --type is set, filter out packages that don't match
          if (opts.type) {
            for (const r of response.results) {
              if (
                r.found &&
                r.packageType &&
                r.packageType !== opts.type
              ) {
                r.found = false;
                r.verdict = "unknown";
                r.trustLevel = 0;
                response.meta.found--;
                response.meta.notFound++;
              }
            }
          }

          if (globalOpts.json) {
            console.log(formatJson(response));
          } else {
            console.log(formatBatchResults(response, minTrust));
          }

          // Exit code 2 for policy violation (below threshold or unknown packages).
          // Exit code 1 is reserved for actual errors (network, server). The
          // text's Summary reads the same gate.
          if (!trustGate(response.results, minTrust).passed) {
            process.exitCode = 2;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (globalOpts.json) {
            console.log(formatJson({ error: message }));
          } else {
            // A registry error can quote the registry's response body.
            console.error(`Error: ${stripControlCharacters(message)}`);
            const failure = registryFailureSentence(err, globalOpts.registryUrl);
            if (failure) {
              console.error(`  ${failure}`);
              // `check` scans a package when its registry lookup fails.
              console.error(
                `  Next: run the batch again when the registry answers, or check one package locally with ai-trust check ${shellArg(packages[0].name)}`
              );
            }
          }
          process.exitCode = 1;
        }
      }
    );
}
