/**
 * The "Documentation:" line each `--help` ends with.
 *
 * Registered on the root command at Commander's "afterAll" position, so the
 * root help and the help of each subcommand print it once, after their own
 * text. The URL is the ai-trust page of the OpenA2A documentation site.
 */
import type { EventEmitter } from "node:events";
import type { Command } from "commander";

export const DOCS_URL = "https://opena2a.org/docs/ai-trust";

/**
 * Help text registered at "after" on the command being shown (the root's
 * Telemetry block, check's Examples) already ends with a blank line, so the
 * separating blank line is added only when there is none. Commander keeps
 * help text as "afterHelp" listeners on the command, an EventEmitter that its
 * typings do not declare as one.
 */
export function helpDocsLine(command: Command): string {
  const after = (command as unknown as EventEmitter).listenerCount("afterHelp");
  const gap = after > 0 ? "" : "\n";
  return `${gap}Documentation: ${DOCS_URL}`;
}
