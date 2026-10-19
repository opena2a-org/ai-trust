/**
 * The NO_COLOR convention (https://no-color.org): a NO_COLOR variable that is
 * set and not empty turns color off, as `--no-color` does.
 */

import chalk from "chalk";

/**
 * Turn color off for this run when NO_COLOR asks for it. chalk decides its
 * color level from FORCE_COLOR, the `--no-color` flag and the terminal, and
 * does not read NO_COLOR. A FORCE_COLOR that is set keeps its effect.
 */
export function applyNoColor(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NO_COLOR && env.FORCE_COLOR === undefined) chalk.level = 0;
}
