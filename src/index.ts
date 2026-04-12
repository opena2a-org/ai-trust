#!/usr/bin/env node

/**
 * ai-trust - Trust verification CLI for AI packages.
 *
 * Check MCP servers, A2A agents, and AI tools before you install.
 * Powered by the OpenA2A Registry.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerBatchCommand } from "./commands/batch.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();

program
  .name("ai-trust")
  .description("Check security trust scores for AI agents and MCP servers before installing them")
  .version(`ai-trust ${pkg.version} — trust verification for AI packages`, "-v, --version")
  .option(
    "--registry-url <url>",
    "registry base URL",
    "https://api.oa2a.org"
  )
  .option("--json", "output raw JSON", false)
  .option("--no-color", "disable colored output");

registerCheckCommand(program);
registerAuditCommand(program);
registerBatchCommand(program);

program.parse();
