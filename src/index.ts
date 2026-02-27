#!/usr/bin/env node

/**
 * ai-trust - Trust verification CLI for AI packages.
 *
 * Check MCP servers, A2A agents, and AI tools before you install.
 * Powered by the OpenA2A Registry.
 */

import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerBatchCommand } from "./commands/batch.js";

const program = new Command();

program
  .name("ai-trust")
  .description("Trust verification CLI for AI packages")
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
