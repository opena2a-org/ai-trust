/**
 * `ai-trust --json telemetry [on|off|status]`: the usage telemetry state the
 * text output shows, as one JSON object on stdout.
 */

import type { Status } from "@opena2a/telemetry";

export interface TelemetryJson {
  tool: string;
  /** Whether usage telemetry is on for this invocation. */
  enabled: boolean;
  installId: string;
  configPath: string;
  policyUrl: string;
  /**
   * Set when `telemetry on` saved the choice but the OPENA2A_TELEMETRY
   * variable still keeps usage telemetry off.
   */
  keptOffBy?: "OPENA2A_TELEMETRY";
}

export function telemetryJson(
  tool: string,
  status: Status,
  keptOffByVariable = false,
): TelemetryJson {
  return {
    tool,
    enabled: status.enabled,
    installId: status.installId,
    configPath: status.configPath,
    policyUrl: status.policyURL,
    ...(keptOffByVariable ? { keptOffBy: "OPENA2A_TELEMETRY" as const } : {}),
  };
}

/** The `--json` answer to an action `telemetry` does not know. */
export function unknownTelemetryActionJson(tool: string, action: string): { error: string } {
  return { error: `Unknown action '${action}'. Use: ${tool} telemetry on | off | status` };
}
