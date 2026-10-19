/**
 * oa2a batch - Batch trust lookup for multiple packages.
 */

import type { Command } from "commander";
import type {
  BatchResponse,
  PackageQuery,
  RegistryClient,
  TrustAnswer,
} from "@opena2a/registry-client";
import {
  createRegistryClient,
  registryErrorMessage,
  registryFailureSentence,
} from "../utils/registry-client.js";
import { formatBatchResults, formatJson } from "../output/formatter.js";
import type { BatchAnswer } from "../output/formatter.js";
import { stripControlCharacters } from "../output/sanitize.js";
import { trustGate } from "../output/trust-gate.js";
import { packageTypeChoices, packageTypeProblem } from "../utils/package-type.js";
import { parseMinTrust } from "../utils/min-trust.js";
import { resolveAndLog } from "../utils/resolve.js";
import { shellArg } from "../utils/shell-arg.js";
import { createRequire } from "node:module";

const batchRequire = createRequire(import.meta.url);
const batchPkg = batchRequire("../../package.json");
const AI_TRUST_VERSION: string = batchPkg.version;

/**
 * The batch answers with each package the registry has under a type other
 * than `type` marked `excludedByType`. The registry looks a package up by
 * name and type when a type is given, so it answers a package it has under
 * another type as not found: each package not found is looked up again by
 * name alone. An answer found that way, or found under another type by a
 * registry that does not filter by type, is kept as the registry gave it,
 * `found` included, and the text output lists it under Type mismatch instead
 * of as a package the registry does not have.
 */
async function withTypeMismatches(
  client: RegistryClient,
  response: BatchResponse,
  type: string
): Promise<BatchResponse> {
  const otherType = (r: TrustAnswer): boolean =>
    r.found && !!r.packageType && r.packageType !== type;
  const misses = [...new Set(response.results.filter((r) => !r.found).map((r) => r.name))];
  const byName = new Map<string, TrustAnswer>();
  if (misses.length > 0) {
    const untyped = await client.batchQuery(misses.map((name) => ({ name })));
    for (const r of untyped.results) {
      if (otherType(r)) byName.set(r.name, r);
    }
  }
  const results = response.results.map((r): BatchAnswer => {
    const answer = r.found ? r : (byName.get(r.name) ?? r);
    return otherType(answer) ? { ...answer, excludedByType: true } : answer;
  });
  const found = results.filter((r) => r.found).length;
  return {
    results,
    meta: { ...response.meta, found, notFound: response.meta.total - found },
  };
}

export function registerBatchCommand(program: Command): void {
  program
    .command("batch <names...>")
    .description("Batch trust lookup for multiple packages")
    .option(
      "-t, --type <type>",
      `package type to apply to all packages (${packageTypeChoices()})`
    )
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

        const parsedMinTrust = parseMinTrust(opts.minTrust);
        if ("problem" in parsedMinTrust) {
          usageError(parsedMinTrust.problem);
          return;
        }
        const minTrust = parsedMinTrust.level;

        const typeProblem = packageTypeProblem(opts.type);
        if (typeProblem !== undefined) {
          usageError(typeProblem);
          return;
        }

        // A name given twice, or given both as an MCP shorthand and in full
        // (`server-filesystem`, `@modelcontextprotocol/server-filesystem`),
        // is looked up once and gets one row.
        const lookupNames = [...new Set([...new Set(names)].map(resolveAndLog))];

        if (lookupNames.length > 100) {
          usageError(
            `Too many packages (${lookupNames.length}). The batch API supports a maximum of 100 packages per request.`
          );
          return;
        }

        const packages: PackageQuery[] = lookupNames.map((name) => ({
          name,
          ...(opts.type ? { type: opts.type } : {}),
        }));

        const client = createRegistryClient({
          baseUrl: globalOpts.registryUrl,
          userAgent: `ai-trust/${AI_TRUST_VERSION}`,
        });

        try {
          const answered = await client.batchQuery(packages);
          const response = opts.type
            ? await withTypeMismatches(client, answered, opts.type)
            : answered;

          if (globalOpts.json) {
            console.log(formatJson(response));
          } else {
            console.log(
              formatBatchResults(response, minTrust, {
                type: opts.type,
                terminalWidth: process.stdout.columns,
              }),
            );
          }

          // Exit code 2 for policy violation (below threshold or unknown
          // packages) and for a package --type excluded.
          // Exit code 1 is reserved for actual errors (network, server). The
          // text's Summary reads the same gate.
          if (!trustGate(response.results, minTrust).passed) {
            process.exitCode = 2;
          }
        } catch (err) {
          const message = registryErrorMessage(err);
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
