#!/usr/bin/env node

/**
 * oa2a - OpenA2A Registry trust query CLI.
 *
 * Query trust information for packages registered in the OpenA2A Registry.
 */

import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerBatchCommand } from "./commands/batch.js";

const program = new Command();

program
  .name("oa2a")
  .description("OpenA2A Registry trust query CLI")
  .version("0.1.0")
  .option(
    "--registry-url <url>",
    "registry base URL",
    "https://registry.opena2a.org"
  )
  .option("--json", "output raw JSON", false)
  .option("--no-color", "disable colored output");

registerCheckCommand(program);
registerAuditCommand(program);
registerBatchCommand(program);

program.parse();
