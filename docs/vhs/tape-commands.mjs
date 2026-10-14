// Prints, as a JSON array, the commands a VHS tape types on screen: every `Type` line outside a
// `Hide`..`Show` block, in order. The render script uses the list for the text capture and for the
// sidecar's commands[], so the tape is the one place a recorded command is written.
// Usage: node tape-commands.mjs <tape>
import { readFileSync } from "node:fs";
const commands = [];
let hidden = false;
for (const raw of readFileSync(process.argv[2], "utf8").split("\n")) {
  const line = raw.trim();
  if (line === "Hide") hidden = true;
  else if (line === "Show") hidden = false;
  else if (!hidden) {
    const typed = line.match(/^Type(?:@\S+)?\s+(["'`])(.*)\1$/);
    if (typed) commands.push(typed[2]);
  }
}
console.log(JSON.stringify(commands));
