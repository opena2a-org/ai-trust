/**
 * The "Telemetry:" block printed after the root `--help`.
 *
 * Two-bucket telemetry disclosure: --help names both consent rails, usage
 * telemetry (default on) and scan contribution (opt-in), so users see the
 * boundary without reading the privacy policy.
 *
 * The first line reports the usage telemetry state in effect for this
 * invocation, so the caller passes the state @opena2a/telemetry resolved (the
 * OPENA2A_TELEMETRY variable, then the saved choice, then the default). Each
 * usage event carries the install ID that `ai-trust telemetry status` prints,
 * kept in the telemetry config file, so the line names it and does not call
 * the telemetry anonymous.
 */

const USAGE_TELEMETRY_ON =
  "Usage telemetry is on and each event carries a persistent install ID. Disable: OPENA2A_TELEMETRY=off";

// The variable only ever forces telemetry off and wins over the saved choice,
// so turning it back on takes both steps.
const ENABLE_STEPS = "unset OPENA2A_TELEMETRY and run ai-trust telemetry on";
const USAGE_TELEMETRY_OFF = `Usage telemetry is off. Enable: ${ENABLE_STEPS}`;

// The toggle hint the shared `telemetry status` renderer prints when usage
// telemetry is off. Its OPENA2A_TELEMETRY=on half cannot turn telemetry on.
const RENDERER_ENABLE_HINT = "'ai-trust telemetry on'  or  OPENA2A_TELEMETRY=on";

/**
 * Output of the `telemetry` subcommand with the renderer's off-state toggle
 * hint replaced by the steps the help footer gives. Other output is returned
 * unchanged.
 */
export function withEnableSteps(telemetryOutput: string): string {
  return telemetryOutput.replace(RENDERER_ENABLE_HINT, ENABLE_STEPS);
}

/**
 * Output of `telemetry on` when OPENA2A_TELEMETRY still turns usage telemetry
 * off, built from the `telemetry status` output for that state: the header
 * says the saved choice is on and the variable keeps it off, and the toggle
 * line names the step that is left.
 */
export function onKeptOffByVariable(statusOutput: string): string {
  const lines = statusOutput.split("\n");
  lines[0] = "Telemetry saved as on for ai-trust, but OPENA2A_TELEMETRY keeps it off.";
  return lines
    .map((line) => (line.includes(RENDERER_ENABLE_HINT) ? "  Enable: unset OPENA2A_TELEMETRY" : line))
    .join("\n");
}

export function helpFooter(usageTelemetryEnabled: boolean): string {
  return `
Telemetry:
  ${usageTelemetryEnabled ? USAGE_TELEMETRY_ON : USAGE_TELEMETRY_OFF}
  Local scans may contribute to the OpenA2A Registry. Disable: --no-contribute (what ai-trust sends for this scan) or ai-trust config contribute off (saved)
`;
}
