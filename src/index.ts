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
const VERSION: string = pkg.version;
const TELEMETRY_TOOL = "ai-trust";
const NON_TRACKED_TELEMETRY_COMMANDS = new Set<string>(["telemetry", "help"]);
const telemetryStartedAt = new Map<string, number>();

const program = new Command();

program
  .name("ai-trust")
  .description("Check security trust scores for AI agents and MCP servers before installing them")
  .option(
    "--registry-url <url>",
    "registry base URL",
    "https://api.oa2a.org"
  )
  .option("--json", "output raw JSON", false)
  .option("--no-color", "disable colored output");

// Two-bucket telemetry disclosure (briefs/scan-result-telemetry-policy.md §7,
// [CHIEF-CSR-014] + [CHIEF-CPO-021]). Surfaces both consent rails on --help so
// users see the boundary without reading the privacy policy.
program.addHelpText(
  "after",
  `
Telemetry:
  Anonymous usage telemetry is on. Disable: OPENA2A_TELEMETRY=off
  Local scans may contribute to the OpenA2A Registry. Disable: --no-contribute or ai-trust telemetry off
`,
);

registerCheckCommand(program);
registerAuditCommand(program);
registerBatchCommand(program);

(async () => {
  // Tier-1 anonymous usage telemetry — default ON; opt-out via
  // OPENA2A_TELEMETRY=off or `ai-trust telemetry off`. Mirrors the
  // pattern shipped in hackmyagent + opena2a-cli (parity).
  // Disclosure surfaces: README, --version line, telemetry subcommand,
  // opena2a.org/telemetry.
  // Silent-post-consent rule (briefs/scan-result-telemetry-policy.md §5):
  // ALL ongoing contribution after opt-in is invisible — no per-scan
  // banner, no "queued for registry" line. ai-trust currently emits
  // none; preserve that.
  const tele = await import("@opena2a/telemetry");
  const cliUi = await import("@opena2a/cli-ui");
  await tele.init({ tool: TELEMETRY_TOOL, version: VERSION });

  // Stream-split --version (cli-ui 0.5.2): bare `ai-trust x.y.z` to stdout
  // (single parseable line), telemetry disclosure to stderr. Use a manual
  // `option:version` handler rather than Commander's `.version()`, which
  // writes everything to stdout and exits.
  const vparts = cliUi.versionLineParts({
    tool: TELEMETRY_TOOL,
    version: VERSION,
    telemetry: tele.status(),
  });
  program.option("-v, --version", "Output the version number");
  program.on("option:version", () => {
    process.stdout.write(vparts.stdout + "\n");
    if (vparts.stderr) process.stderr.write(vparts.stderr + "\n");
    process.exit(0);
  });

  program
    .hook("preAction", (_thisCommand, actionCommand) => {
      const name = actionCommand.name();
      if (NON_TRACKED_TELEMETRY_COMMANDS.has(name)) return;
      telemetryStartedAt.set(name, Date.now());
    })
    .hook("postAction", (_thisCommand, actionCommand) => {
      const name = actionCommand.name();
      const startedAt = telemetryStartedAt.get(name);
      if (startedAt === undefined) return;
      telemetryStartedAt.delete(name);
      void tele.track(name, {
        // Exit 0 = clean, 1 = below-threshold, 2 = not-found. All three
        // are working outcomes per audit.test.ts. Per [CHIEF-CSR-018] +
        // [CHIEF-CPO-022], pass [2] so the dashboard treats not-found as
        // success (crash-rate semantics, not user-outcome semantics).
        // Real crashes are exit >=3 or out-of-range — those stay failure.
        success: tele.successFromExitCode(process.exitCode, [2]),
        durationMs: Date.now() - startedAt,
      });
    });

  program
    .command("telemetry [action]")
    .description("Inspect or toggle anonymous usage telemetry: on | off | status")
    .action((action: string | undefined) => {
      console.log(
        cliUi.runTelemetryCommand(action as Parameters<typeof cliUi.runTelemetryCommand>[0], {
          tool: TELEMETRY_TOOL,
          getStatus: tele.status,
          setOptOut: tele.setOptOut,
        }),
      );
      // An unrecognized action prints "Unknown action …" but must also exit
      // non-zero so scripts and CI can detect the usage error (release-test P3).
      const knownActions = new Set(["on", "off", "status", "--help", "-h"]);
      if (action !== undefined && !knownActions.has(action)) {
        process.exitCode = 1;
      }
    });

  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const inFlight = telemetryStartedAt.keys().next().value;
    if (inFlight) {
      const code = err instanceof Error ? err.name : "unknown";
      tele.error(inFlight, code);
    }
    throw err;
  } finally {
    await tele.flush();
  }
})();
