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
import { registerConfigCommand } from "./commands/config.js";
import { helpFooter, onKeptOffByVariable, withEnableSteps } from "./utils/help-footer.js";
import { helpDocsLine } from "./utils/help-docs.js";
import { telemetryJson, unknownTelemetryActionJson } from "./utils/telemetry-json.js";
import { scanPingsSettled } from "./telemetry/contribute.js";
import { readContributeChoice } from "./telemetry/opt-in.js";
import { DEFAULT_REGISTRY_URL, registryUrlProblem } from "./utils/registry-url.js";
import { formatJson } from "./output/formatter.js";
import { stripControlCharacters } from "./output/sanitize.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const VERSION: string = pkg.version;
const TELEMETRY_TOOL = "ai-trust";
const NON_TRACKED_TELEMETRY_COMMANDS = new Set<string>(["telemetry", "help"]);
const telemetryStartedAt = new Map<string, number>();
// The telemetry sender aborts a request after 2 s, but an aborted connect to
// an address that drops packets (a firewall that drops egress) keeps its
// socket, and so this process, alive until the socket's own connect timeout,
// about 10 s. The exit is capped this long after the command finishes. Two
// things are waited for past the cap: a scan ping still in flight, and output
// a reader has not taken yet.
const TELEMETRY_EXIT_CAP_MS = 2000;

// Resolves once everything already written to the stream has been handed to
// the OS, so a forced exit cannot cut off output still queued for a pipe.
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

// Thrown by a check that has already printed its error and set the exit code.
class ReportedUsageError extends Error {}

const program = new Command();

program
  .name("ai-trust")
  .description("Check security trust scores for AI agents and MCP servers before installing them")
  .option(
    "--registry-url <url>",
    "registry base URL",
    DEFAULT_REGISTRY_URL
  )
  .option("--json", "output raw JSON", false)
  .option("--no-color", "disable colored output");

// The registry client throws a TypeError for a base URL that is not http(s),
// which ended a command in a stack trace. The value is checked here, before
// any command's action runs; this hook is registered ahead of the telemetry
// hooks, so a refused value starts no telemetry timing.
program.hook("preAction", (thisCommand) => {
  const { registryUrl, json } = thisCommand.opts() as { registryUrl: string; json: boolean };
  const problem = registryUrlProblem(registryUrl);
  if (problem === undefined) return;
  if (json) {
    console.log(formatJson({ error: problem }));
  } else {
    console.error(`Error: ${stripControlCharacters(problem)}`);
  }
  process.exitCode = 1;
  throw new ReportedUsageError(problem);
});

registerCheckCommand(program);
registerAuditCommand(program);
registerBatchCommand(program);
registerConfigCommand(program);

// "afterAll" on the root: every help, the root's and each subcommand's, ends
// with the documentation URL.
program.addHelpText("afterAll", ({ command }) => helpDocsLine(command));

(async () => {
  // Tier-1 usage telemetry — default ON; opt-out via
  // OPENA2A_TELEMETRY=off or `ai-trust telemetry off`. Mirrors the
  // pattern shipped in hackmyagent + opena2a-cli (parity).
  // Disclosure surfaces: README, --help footer, --version line, telemetry
  // subcommand, opena2a.org/telemetry.
  // Silent-post-consent rule: once the user has opted in, contribution
  // prints nothing per scan — no banner, no "queued for registry" line;
  // disclosure lives in the consent prompt, --help and the privacy
  // policy. ai-trust currently emits none; preserve that.
  const tele = await import("@opena2a/telemetry");
  const cliUi = await import("@opena2a/cli-ui");
  await tele.init({ tool: TELEMETRY_TOOL, version: VERSION });

  // Registered after init: the footer states the usage telemetry state that
  // init resolved for this invocation, and the saved contribution choice,
  // which is read only when the help is printed.
  program.addHelpText("after", () => helpFooter(tele.status().enabled, readContributeChoice()));

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
        // are working outcomes per audit.test.ts. Pass [2] so the
        // dashboard treats not-found as success (crash-rate semantics,
        // not user-outcome semantics).
        // Real crashes are exit >=3 or out-of-range — those stay failure.
        success: tele.successFromExitCode(process.exitCode, [2]),
        durationMs: Date.now() - startedAt,
      });
    });

  program
    .command("telemetry [action]")
    .description("Inspect or toggle usage telemetry: on | off | status")
    .action(async (action: string | undefined) => {
      const telemetryInput = {
        tool: TELEMETRY_TOOL,
        getStatus: tele.status,
        setOptOut: tele.setOptOut,
      };
      let output = cliUi.runTelemetryCommand(
        action as Parameters<typeof cliUi.runTelemetryCommand>[0],
        telemetryInput,
      );
      let keptOffByVariable = false;
      if (action === "on") {
        // setOptOut marks this run on, but OPENA2A_TELEMETRY=off wins over the
        // saved choice on every run; init resolves the state in effect again.
        await tele.init({ tool: TELEMETRY_TOOL, version: VERSION });
        if (!tele.status().enabled) {
          keptOffByVariable = true;
          output = onKeptOffByVariable(cliUi.runTelemetryCommand("status", telemetryInput));
        }
      }
      // An unrecognized action prints "Unknown action …" but must also exit
      // non-zero so scripts and CI can detect the usage error (release-test P3).
      const knownActions = new Set(["on", "off", "status", "--help", "-h"]);
      const unknownAction =
        action !== undefined && !knownActions.has(action) ? action : undefined;
      const { json } = program.opts() as { json: boolean };
      if (json && unknownAction !== undefined) {
        console.log(JSON.stringify(unknownTelemetryActionJson(TELEMETRY_TOOL, unknownAction), null, 2));
      } else if (json && action !== "--help" && action !== "-h") {
        console.log(
          JSON.stringify(telemetryJson(TELEMETRY_TOOL, tele.status(), keptOffByVariable), null, 2),
        );
      } else {
        console.log(withEnableSteps(output));
      }
      if (unknownAction !== undefined) {
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
    if (err instanceof ReportedUsageError) return;
    const inFlight = telemetryStartedAt.keys().next().value;
    if (inFlight) {
      const code = err instanceof Error ? err.name : "unknown";
      tele.error(inFlight, code);
    }
    throw err;
  } finally {
    const exitDeadline = Date.now() + TELEMETRY_EXIT_CAP_MS;
    // A scan ping still in flight is waited for past the cap: the ping's own
    // timeout bounds the wait.
    await Promise.all([tele.flush(), scanPingsSettled()]);
    await Promise.all([drained(process.stdout), drained(process.stderr)]);
    // Unref'd: a process with nothing left to do exits without waiting for it.
    setTimeout(
      () => process.exit(process.exitCode ?? 0),
      Math.max(0, exitDeadline - Date.now()),
    ).unref();
  }
})();
