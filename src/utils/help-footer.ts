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
const USAGE_TELEMETRY_OFF =
  "Usage telemetry is off. Enable: unset OPENA2A_TELEMETRY and run ai-trust telemetry on";

export function helpFooter(usageTelemetryEnabled: boolean): string {
  return `
Telemetry:
  ${usageTelemetryEnabled ? USAGE_TELEMETRY_ON : USAGE_TELEMETRY_OFF}
  Local scans may contribute to the OpenA2A Registry. Disable: --no-contribute (what ai-trust sends for this scan) or ai-trust config contribute off (saved)
  With contribution saved on, a default scan also sends the bundled scanner's classification
  telemetry (per-file content hash and verdict); --no-contribute does not stop it.
  Stop it: --no-deep or ai-trust config contribute off
`;
}
