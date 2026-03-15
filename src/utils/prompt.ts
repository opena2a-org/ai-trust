/**
 * Interactive prompt utility for terminal input.
 */

import { createInterface } from "node:readline";

/**
 * Ask a yes/no question. Returns true for yes (default), false for no.
 * In non-interactive mode (no TTY), returns the default value.
 */
export async function confirm(
  question: string,
  defaultYes = true
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return defaultYes;
  }

  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr so stdout stays clean for JSON/piping
  });

  return new Promise((resolve) => {
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolve(defaultYes);
      } else {
        resolve(trimmed === "y" || trimmed === "yes");
      }
    });
  });
}
